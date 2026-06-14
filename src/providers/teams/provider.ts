import { createPublicKey, createVerify } from 'node:crypto';
import type { ChannelProvider, Logger } from '../../core/provider.js';
import type { MessageStore } from '../../core/store.js';
import type { InboundEvent, OutboundMessage, SendResult } from '../../core/types.js';
import { teamsActivitySchema, type TeamsActivity } from './payloads.js';

export interface TeamsConfig {
  appId: string;
  appPassword: string;
  /**
   * Tenant ID para bots single-tenant.
   * Omitir para multi-tenant (usa 'botframework.com' como tenant do token).
   */
  tenantId?: string | undefined;
}

interface JwkRsaKey {
  kid?: string;
  kty: string;
  n: string;
  e: string;
  [k: string]: unknown;
}

const BOT_FRAMEWORK_OIDC =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';
const MICROSOFT_TOKEN_BASE = 'https://login.microsoftonline.com';
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';

export class TeamsProvider implements ChannelProvider {
  readonly channel = 'teams' as const;

  // OAuth2 token cache
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  // JWKS cache para verificação de JWT inbound
  private jwksKeys: JwkRsaKey[] = [];
  private jwksRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // serviceUrl por conversationId — necessário para reply/edit/delete
  private serviceUrlCache = new Map<string, string>();
  // serviceUrl e tenantId padrão (da última atividade recebida) para mensagens proativas
  private defaultServiceUrl: string | null = null;
  private defaultTenantId: string | null = null;

  constructor(private readonly config: TeamsConfig) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(_context: { store: MessageStore; log: Logger }): Promise<void> {
    await this.refreshJwks();
    // Chaves do Bot Framework rotacionam esporadicamente — refresh diário
    this.jwksRefreshTimer = setInterval(
      () => { void this.refreshJwks(); },
      24 * 60 * 60 * 1000,
    );
  }

  async stop(): Promise<void> {
    if (this.jwksRefreshTimer !== null) {
      clearInterval(this.jwksRefreshTimer);
      this.jwksRefreshTimer = null;
    }
  }

  // ── Verificação ────────────────────────────────────────────────────────────

  handleVerification(_query: Record<string, unknown>): string | null {
    // Teams não usa handshake GET — autenticação se dá via JWT no cabeçalho das POSTs
    return null;
  }

  verifySignature(
    _rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const authHeader = headers['authorization'];
    if (typeof authHeader !== 'string') return false;
    if (!authHeader.startsWith('Bearer ')) return false;
    return this.verifyJwt(authHeader.slice(7));
  }

  // ── Tradução de eventos ────────────────────────────────────────────────────

  parseWebhook(body: unknown): InboundEvent[] {
    const parsed = teamsActivitySchema.safeParse(body);
    if (!parsed.success) return [{ kind: 'unknown', raw: body }];

    const activity = parsed.data;

    // Persiste serviceUrl por conversa para poder enviar respostas depois
    this.serviceUrlCache.set(activity.conversation.id, activity.serviceUrl);
    this.defaultServiceUrl = activity.serviceUrl;
    if (activity.channelData?.tenant?.id) {
      this.defaultTenantId = activity.channelData.tenant.id;
    }

    switch (activity.type) {
      case 'message':
        return this.parseMessage(activity);
      case 'messageReaction':
        return this.parseReaction(activity);
      default:
        return [{ kind: 'unknown', raw: body }];
    }
  }

  private parseMessage(activity: TeamsActivity): InboundEvent[] {
    if (!activity.id || !activity.from) return [{ kind: 'unknown', raw: activity }];

    // IDs de bot começam com "28:" — ignora para não criar loops
    if (activity.from.id.startsWith('28:')) return [];

    const conversationId = activity.conversation.id;
    const providerMessageId = `${conversationId}|${activity.id}`;

    const content = this.toContent(activity);

    return [
      {
        kind: 'message',
        message: {
          providerMessageId,
          from: activity.from.id,
          timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
          content,
          ...(activity.replyToId
            ? { replyTo: `${conversationId}|${activity.replyToId}` }
            : {}),
          raw: activity,
        },
      },
    ];
  }

  private parseReaction(activity: TeamsActivity): InboundEvent[] {
    if (!activity.from || !activity.replyToId) return [{ kind: 'unknown', raw: activity }];

    const conversationId = activity.conversation.id;
    const reactions = [
      ...(activity.reactionsAdded ?? []),
      ...(activity.reactionsRemoved ?? []),
    ];

    return reactions.map((r) => ({
      kind: 'message' as const,
      message: {
        // Reações no Teams não têm ID próprio — composição é única
        providerMessageId: `rxn:${activity.from!.id}:${conversationId}:${activity.replyToId}:${r.type}`,
        from: activity.from!.id,
        timestamp: activity.timestamp ? new Date(activity.timestamp) : new Date(),
        content: {
          kind: 'reaction' as const,
          targetMessageId: `${conversationId}|${activity.replyToId}`,
          emoji: r.type,
        },
        raw: activity,
      },
    }));
  }

  private toContent(activity: TeamsActivity) {
    if (activity.text?.trim()) {
      return { kind: 'text' as const, text: activity.text.trim() };
    }
    if (activity.attachments.length > 0) {
      const att = activity.attachments[0]!;
      return {
        kind: 'media' as const,
        mediaType: guessMediaType(att.contentType),
        url: att.contentUrl,
        caption: att.name,
      };
    }
    return { kind: 'unsupported' as const, nativeType: 'teams_message_no_content' };
  }

  // ── Envio via Bot Framework REST ───────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const content = message.content;

    if (content.kind === 'reaction') {
      // Envio de reações exige Microsoft Graph API (escopo separado)
      throw new Error(
        'Teams: envio de reações não suportado via Bot Framework — use Microsoft Graph API',
      );
    }

    const conversationId = message.to;
    const serviceUrl = this.serviceUrlCache.get(conversationId) ?? this.defaultServiceUrl;
    if (!serviceUrl) {
      throw new Error(
        `Teams: serviceUrl desconhecido para a conversa "${conversationId}". ` +
          'Aguarde a primeira mensagem do usuário para que o serviceUrl seja cacheado.',
      );
    }

    const body: Record<string, unknown> = { type: 'message' };

    if (message.replyTo !== undefined) {
      const [, replyActivityId] = splitCompositeId(message.replyTo);
      body['replyToId'] = replyActivityId;
    }

    switch (content.kind) {
      case 'text':
        body['text'] = content.text;
        break;

      case 'media':
        if (content.url !== undefined) {
          body['attachments'] = [
            {
              contentType: mimeFromMediaType(content.mediaType),
              contentUrl: content.url,
              name: content.caption,
            },
          ];
          if (content.caption) body['text'] = content.caption;
        } else {
          throw new Error('Teams: envio de mídia exige url — upload direto não suportado aqui');
        }
        break;

      default:
        throw new Error(
          `Teams: kind "${(content as { kind: string }).kind}" não suportado para envio`,
        );
    }

    const raw = await this.restPost<{ id: string }>(
      serviceUrl,
      `/v3/conversations/${encodeURIComponent(conversationId)}/activities`,
      body,
    );

    return { providerMessageId: `${conversationId}|${raw.id}`, raw };
  }

  async markAsRead(_providerMessageId: string): Promise<void> {
    // Teams não expõe "marcar como lida" via Bot Framework
  }

  // ── Edição e exclusão ──────────────────────────────────────────────────────

  async editMessage(providerMessageId: string, text: string): Promise<void> {
    const [conversationId, activityId] = splitCompositeId(providerMessageId);
    const serviceUrl = this.requireServiceUrl(conversationId);
    const token = await this.getAccessToken();

    const url =
      `${normalizeServiceUrl(serviceUrl)}/v3/conversations/${encodeURIComponent(conversationId)}` +
      `/activities/${encodeURIComponent(activityId)}`;

    const res = await fetch(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', text }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Teams API PUT activity → ${res.status}: ${detail}`);
    }
  }

  async deleteMessage(providerMessageId: string): Promise<void> {
    const [conversationId, activityId] = splitCompositeId(providerMessageId);
    const serviceUrl = this.requireServiceUrl(conversationId);
    const token = await this.getAccessToken();

    const url =
      `${normalizeServiceUrl(serviceUrl)}/v3/conversations/${encodeURIComponent(conversationId)}` +
      `/activities/${encodeURIComponent(activityId)}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok && res.status !== 204) {
      const detail = await res.text();
      throw new Error(`Teams API DELETE activity → ${res.status}: ${detail}`);
    }
  }

  // ── Destinos e DM ──────────────────────────────────────────────────────────

  async listDestinations(): Promise<Array<{ id: string; label: string; group?: string }>> {
    // Retorna conversas conhecidas do cache (populado por mensagens recebidas)
    // Listagem completa de times/canais exigiria Microsoft Graph API (escopo adicional)
    return Array.from(this.serviceUrlCache.keys()).map((id) => ({
      id,
      label: id,
      group: 'Conversas conhecidas',
    }));
  }

  /**
   * Abre (ou recupera) uma conversa 1:1 com um usuário.
   * userId deve estar no formato Teams ("29:xxx") ou ser o AAD Object ID.
   * Requer que o bot já tenha recebido ao menos uma atividade (para ter um serviceUrl cacheado).
   */
  async openDM(userId: string): Promise<string> {
    const serviceUrl = this.defaultServiceUrl;
    if (!serviceUrl) {
      throw new Error(
        'Teams: nenhum serviceUrl cacheado. ' +
          'O bot precisa ter recebido ao menos uma atividade antes de abrir DMs proativos.',
      );
    }

    const memberId = userId.startsWith('29:') ? userId : `29:${userId}`;

    const body: Record<string, unknown> = {
      bot: { id: `28:${this.config.appId}`, name: 'Bot' },
      members: [{ id: memberId }],
      isGroup: false,
    };
    if (this.defaultTenantId) body['tenantId'] = this.defaultTenantId;

    const raw = await this.restPost<{ id: string; serviceUrl?: string }>(
      serviceUrl,
      '/v3/conversations',
      body,
    );

    const newServiceUrl = raw.serviceUrl ?? serviceUrl;
    this.serviceUrlCache.set(raw.id, newServiceUrl);

    return raw.id;
  }

  // ── OAuth2 e JWKS ──────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }

    // Multi-tenant: tenant é 'botframework.com'; single-tenant: usar o tenant real
    const tenant = this.config.tenantId ?? 'botframework.com';
    const res = await fetch(`${MICROSOFT_TOKEN_BASE}/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.appId,
        client_secret: this.config.appPassword,
        scope: BOT_FRAMEWORK_SCOPE,
      }).toString(),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Teams OAuth2: falha ao obter token → ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.tokenExpiry = Date.now() + json.expires_in * 1000;

    return this.accessToken;
  }

  private async refreshJwks(): Promise<void> {
    const oidcRes = await fetch(BOT_FRAMEWORK_OIDC);
    if (!oidcRes.ok) {
      throw new Error(`Teams: falha ao buscar OpenID config do Bot Framework → ${oidcRes.status}`);
    }

    const oidc = (await oidcRes.json()) as { jwks_uri: string };

    const jwksRes = await fetch(oidc.jwks_uri);
    if (!jwksRes.ok) {
      throw new Error(`Teams: falha ao buscar JWKS → ${jwksRes.status}`);
    }

    const jwks = (await jwksRes.json()) as { keys: JwkRsaKey[] };
    this.jwksKeys = jwks.keys.filter((k) => k.kty === 'RSA');
  }

  private verifyJwt(token: string): boolean {
    if (this.jwksKeys.length === 0) return false;

    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    let header: { alg?: string; kid?: string };
    let payload: { iss?: string; aud?: string; nbf?: number; exp?: number };

    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as typeof header;
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as typeof payload;
    } catch {
      return false;
    }

    if (header.alg !== 'RS256') return false;

    // Verifica claims padrão JWT do Bot Framework
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== BOT_FRAMEWORK_ISSUER) return false;
    if (payload.aud !== this.config.appId) return false;
    if (typeof payload.exp === 'number' && payload.exp < now) return false;
    // Leniência de 5 min para drift de relógio
    if (typeof payload.nbf === 'number' && payload.nbf > now + 300) return false;

    // Seleciona a chave pelo kid; cai na primeira RSA se não houver correspondência
    const jwk = header.kid
      ? (this.jwksKeys.find((k) => k.kid === header.kid) ?? this.jwksKeys[0])
      : this.jwksKeys[0];

    if (!jwk) return false;

    try {
      const publicKey = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      const data = Buffer.from(`${headerB64}.${payloadB64}`);
      const sig = Buffer.from(sigB64, 'base64url');

      const verifier = createVerify('RSA-SHA256');
      verifier.update(data);
      return verifier.verify(publicKey, sig);
    } catch {
      return false;
    }
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private requireServiceUrl(conversationId: string): string {
    const url = this.serviceUrlCache.get(conversationId) ?? this.defaultServiceUrl;
    if (!url) {
      throw new Error(
        `Teams: serviceUrl desconhecido para a conversa "${conversationId}". ` +
          'Aguarde a primeira mensagem do usuário.',
      );
    }
    return url;
  }

  private async restPost<T>(serviceUrl: string, path: string, body: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${normalizeServiceUrl(serviceUrl)}${path}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Teams API POST ${path} → ${res.status}: ${detail}`);
    }

    return res.json() as Promise<T>;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Separa o providerMessageId composto do Teams (conversationId|activityId).
 * Usa lastIndexOf para tolerar '|' eventual dentro do conversationId.
 */
function splitCompositeId(id: string): [conversationId: string, activityId: string] {
  const idx = id.lastIndexOf('|');
  if (idx === -1) throw new Error(`providerMessageId Teams inválido (sem '|'): ${id}`);
  return [id.slice(0, idx), id.slice(idx + 1)];
}

function normalizeServiceUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function guessMediaType(contentType: string): 'image' | 'audio' | 'video' | 'document' {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'document';
}

function mimeFromMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image': return 'image/*';
    case 'audio': return 'audio/*';
    case 'video': return 'video/*';
    default: return 'application/octet-stream';
  }
}
