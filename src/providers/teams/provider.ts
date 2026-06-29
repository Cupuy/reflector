import { createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelProvider, Logger } from '../../core/provider.js';
import type { MessageStore } from '../../core/store.js';
import type { InboundEvent, OutboundMessage, SendResult } from '../../core/types.js';
import {
  graphChatMessageSchema,
  graphNotificationBodySchema,
  teamsActivitySchema,
  type GraphChatMessage,
  type TeamsActivity,
} from './payloads.js';

export interface TeamsConfig {
  appId: string;
  appPassword: string;
  /**
   * Tenant ID para bots single-tenant.
   * Omitir para multi-tenant (usa 'botframework.com' como tenant do token).
   */
  tenantId?: string | undefined;
  /**
   * Caminho de um arquivo onde o cache de serviceUrl (necessário para mensagens
   * proativas) é persistido entre restarts. Sem isso, o cache vive só em memória
   * e qualquer restart (inclusive os do `tsx watch` durante o dev) exige que o bot
   * receba uma nova activity antes que `openDM`/proativas voltem a funcionar.
   */
  statePath?: string | undefined;
  /**
   * URL pública do servidor (ex.: domínio do ngrok), usada só para autorregistrar o
   * callback de change notifications do Microsoft Graph (`POST /subscriptions`).
   * Sem isso, `subscribeToChannelMessages()` não tem como montar o `notificationUrl`.
   */
  publicBaseUrl?: string | undefined;
}

interface TeamsPersistedState {
  serviceUrls: Record<string, string>;
  defaultServiceUrl: string | null;
  defaultTenantId: string | null;
  // nome (se já visto) de cada team em que o bot foi instalado — null até a primeira
  // activity que o traga; usado só para rotular grupos em listDestinations()
  teamNames: Record<string, string | null>;
  // segredo compartilhado com o Microsoft Graph, ecoado em toda change notification —
  // gerado uma vez (lazy) e reaproveitado por todas as assinaturas futuras
  graphClientState: string | null;
  // assinaturas ativas de change notification por canal, chave `${teamId}|${channelId}`
  channelSubscriptions: Record<string, { subscriptionId: string; expirationDateTime: string; changeType?: string }>;
  // mapeamento threadId (19:xxx@thread.tacv2) → Azure AD Group ID (GUID) —
  // o Graph exige o GUID para subscriptions, mas channelData.team.id às vezes vem como thread ID
  teamAadGroupIds: Record<string, string>;
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

  // OAuth2 token cache (Bot Framework Connector API)
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  // OAuth2 token cache (Microsoft Graph — escopo e permissões separados do Bot Framework)
  private graphAccessToken: string | null = null;
  private graphTokenExpiry = 0;

  // JWKS cache para verificação de JWT inbound
  private jwksKeys: JwkRsaKey[] = [];
  private jwksRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // serviceUrl por conversationId — necessário para reply/edit/delete
  private serviceUrlCache = new Map<string, string>();
  // serviceUrl e tenantId padrão (da última atividade recebida) para mensagens proativas
  private defaultServiceUrl: string | null = null;
  private defaultTenantId: string | null = null;
  // teams em que o bot foi instalado — teamId -> nome (null se ainda não observado)
  private teamNames = new Map<string, string | null>();

  // segredo compartilhado com o Graph para validar change notifications (lazy, ver subscribeToChannelMessages)
  private graphClientState: string | null = null;
  // assinaturas ativas de change notification — chave `${teamId}|${channelId}`
  private channelSubscriptions = new Map<string, { subscriptionId: string; expirationDateTime: string; changeType: string }>();
  // threadId (19:xxx@thread.tacv2) → Azure AD Group ID (GUID) para chamadas ao Microsoft Graph
  private teamAadGroupIds = new Map<string, string>();
  private subscriptionRenewalTimer: ReturnType<typeof setInterval> | null = null;
  private log: Logger | null = null;

  constructor(private readonly config: TeamsConfig) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(context: { store: MessageStore; log: Logger }): Promise<void> {
    this.log = context.log;
    this.loadState();
    await this.refreshJwks();
    // Chaves do Bot Framework rotacionam esporadicamente — refresh diário
    this.jwksRefreshTimer = setInterval(
      () => { void this.refreshJwks(); },
      24 * 60 * 60 * 1000,
    );
    // Assinaturas de canal expiram em ~60min (limite do Graph para chatMessage) — renova
    // bem antes disso para tolerar o servidor ficar fora por um tempo entre checagens
    this.subscriptionRenewalTimer = setInterval(
      () => { void this.renewChannelSubscriptions(); },
      15 * 60 * 1000,
    );
  }

  async stop(): Promise<void> {
    if (this.jwksRefreshTimer !== null) {
      clearInterval(this.jwksRefreshTimer);
      this.jwksRefreshTimer = null;
    }
    if (this.subscriptionRenewalTimer !== null) {
      clearInterval(this.subscriptionRenewalTimer);
      this.subscriptionRenewalTimer = null;
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
    // Registra o team (se a activity veio de contexto de canal/grupo) — nome pode não
    // vir em toda activity, então só sobrescreve quando de fato presente.
    // aadGroupId é o Azure AD Group ID (GUID) necessário para chamadas ao Microsoft Graph —
    // channelData.team.id às vezes vem como thread ID (19:xxx@thread.tacv2) em vez de GUID.
    const teamId = activity.channelData?.team?.id;
    if (teamId) {
      const teamName = activity.channelData?.team?.name ?? this.teamNames.get(teamId) ?? null;
      this.teamNames.set(teamId, teamName);
      const aadGroupId = activity.channelData?.team?.aadGroupId;
      if (aadGroupId) {
        this.teamAadGroupIds.set(teamId, aadGroupId);
      }
    }
    this.saveState();

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
    const text = this.stripBotMention(activity);
    if (text) {
      return { kind: 'text' as const, text };
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

  /**
   * Em canal/grupo o Teams só entrega a activity ao bot quando ele é @mencionado,
   * e o texto vem com o trecho da menção embutido (ex.: "<at>NomeDoBot</at> oi") —
   * sem isso, toda mensagem de canal apareceria com esse lixo de marcação na frente.
   */
  private stripBotMention(activity: TeamsActivity): string {
    let text = activity.text ?? '';
    const botId = activity.recipient?.id;
    for (const entity of activity.entities) {
      if (entity.type === 'mention' && entity.mentioned?.id === botId && entity.text) {
        text = text.replace(entity.text, '');
      }
    }
    return text.trim();
  }

  // ── Envio via Bot Framework REST ───────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const content = message.content;

    if (content.kind === 'reaction') {
      // Sem caminho viável: Bot Framework Connector não expõe nenhuma operação de
      // reação (só recebe `messageReaction`); Microsoft Graph `setReaction` não aceita
      // permissão de aplicativo, só delegada — e mesmo com OAuth delegado a reação
      // apareceria como tendo sido feita pelo usuário logado, não pelo bot.
      // Ver docs/learnings.md (Microsoft Teams) para os detalhes da investigação.
      throw new Error(
        'Teams: bot não pode enviar reações com a própria identidade — nem Bot Framework ' +
          'nem Microsoft Graph (app-only) suportam; Graph delegado atribuiria a reação ao ' +
          'usuário autenticado, não ao bot',
      );
    }

    // `channel:<teamId>|<channelId>` indica um post novo (não-reply) num canal de team —
    // diferente de DM/reply, isso exige criar a conversa com a activity já embutida
    // (ver postToChannel) em vez de postar em /activities de uma conversationId existente.
    if (message.to.startsWith('channel:')) {
      return this.postToChannel(message.to.slice('channel:'.length), message);
    }

    const conversationId = message.to;
    const serviceUrl = this.serviceUrlCache.get(conversationId) ?? this.defaultServiceUrl;
    if (!serviceUrl) {
      throw new Error(
        `Teams: serviceUrl desconhecido para a conversa "${conversationId}". ` +
          'Aguarde a primeira mensagem do usuário para que o serviceUrl seja cacheado.',
      );
    }

    const body = this.buildActivityBody(message);

    const raw = await this.restPost<{ id: string }>(
      serviceUrl,
      `/v3/conversations/${encodeURIComponent(conversationId)}/activities`,
      body,
    );

    return { providerMessageId: `${conversationId}|${raw.id}`, raw };
  }

  /**
   * Cria um post novo (início de reply chain) num canal específico de um team.
   * Diferente de DM/reply: a Connector API exige criar a conversa com a activity já
   * dentro do corpo (`POST /v3/conversations` com `channelData.channel`), não criar a
   * conversa vazia e postar depois — ver docs/learnings.md (Microsoft Teams).
   */
  private async postToChannel(teamAndChannel: string, message: OutboundMessage): Promise<SendResult> {
    const [teamId, channelId] = splitCompositeId(teamAndChannel);
    const serviceUrl = this.defaultServiceUrl;
    if (!serviceUrl) {
      throw new Error(
        'Teams: nenhum serviceUrl cacheado. O bot precisa ter recebido ao menos uma activity antes de postar em canais.',
      );
    }

    const body: Record<string, unknown> = {
      activity: this.buildActivityBody(message),
      bot: { id: `28:${this.config.appId}`, name: 'Bot' },
      channelData: {
        channel: { id: channelId },
        team: { id: teamId },
        ...(this.defaultTenantId ? { tenant: { id: this.defaultTenantId } } : {}),
      },
      isGroup: true,
      ...(this.defaultTenantId ? { tenantId: this.defaultTenantId } : {}),
    };

    const raw = await this.restPost<{ id: string; activityId: string }>(
      serviceUrl,
      '/v3/conversations',
      body,
    );

    this.serviceUrlCache.set(raw.id, serviceUrl);
    this.saveState();

    return { providerMessageId: `${raw.id}|${raw.activityId}`, raw };
  }

  private buildActivityBody(message: OutboundMessage): Record<string, unknown> {
    const content = message.content;
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

    return body;
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
    const results: Array<{ id: string; label: string; group?: string }> = [];

    // Conversas 1:1 conhecidas — sempre prefixo "a:", diferente dos ids de canal/thread
    // (prefixo "19:"), que são listados de forma completa abaixo via fetchChannelList
    for (const conversationId of this.serviceUrlCache.keys()) {
      if (!conversationId.startsWith('a:')) continue;
      results.push({ id: conversationId, label: conversationId, group: 'Conversas diretas conhecidas' });
    }

    // Canais de cada team conhecido — busca completa via Connector API (não só os
    // canais onde o bot já foi @mencionado, que é tudo que `serviceUrlCache` teria)
    for (const [teamId, teamName] of this.teamNames) {
      try {
        const channels = await this.fetchChannelList(teamId);
        // Best-effort: a Connector API não expõe membershipType, só Graph. Sem a permissão
        // de aplicativo `Channel.ReadBasic.All` (ou sem TEAMS_TENANT_ID), degrada silenciosamente
        // para "sem indicação de privacidade" em vez de quebrar a listagem inteira.
        const membershipTypes = await this.fetchChannelMembershipTypes(teamId).catch(
          () => new Map<string, string>(),
        );
        for (const ch of channels) {
          // Canal privado/compartilhado exige membership própria (ver docs/learnings.md,
          // item "Canais privados exigem membership própria") — sinaliza no label para que
          // o dashboard não deixe escolher um canal restrito sem aviso.
          const restricted = membershipTypes.get(ch.id) === 'private' || membershipTypes.get(ch.id) === 'shared';
          results.push({
            id: `channel:${teamId}|${ch.id}`,
            label: (restricted ? '🔒 ' : '') + (ch.name ?? 'Geral'),
            group: teamName ?? teamId,
          });
        }
      } catch {
        // team sem canal acessível (ex.: permissão) — ignora, como o Discord faz para guilds sem acesso
      }
    }

    return results;
  }

  /** Lista todos os canais de um team — não exige activity prévia em cada canal individualmente. */
  private async fetchChannelList(teamId: string): Promise<Array<{ id: string; name: string | null }>> {
    const serviceUrl = this.defaultServiceUrl;
    if (!serviceUrl) return [];

    const token = await this.getAccessToken();
    const url = `${normalizeServiceUrl(serviceUrl)}/v3/teams/${encodeURIComponent(teamId)}/conversations`;

    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Teams API GET /v3/teams/${teamId}/conversations → ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { conversations: Array<{ id: string; name: string | null }> };
    return json.conversations;
  }

  /**
   * Busca o membershipType ("standard" | "private" | "shared") de cada canal de um team via
   * Microsoft Graph — a Bot Framework Connector API (fetchChannelList) só retorna id/name,
   * sem indicação de privacidade. Requer permissão de aplicativo `Channel.ReadBasic.All`.
   */
  private async fetchChannelMembershipTypes(teamId: string): Promise<Map<string, string>> {
    const graphTeamId = this.teamAadGroupIds.get(teamId) ?? teamId;
    if (!isGuid(graphTeamId)) throw new Error(`aadGroupId não disponível para team "${teamId}"`);
    const token = await this.getGraphAccessToken();
    const url = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(graphTeamId)}/channels?$select=id,membershipType`;

    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Teams Graph GET /teams/${teamId}/channels → ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { value: Array<{ id: string; membershipType: string }> };
    return new Map(json.value.map((c) => [c.id, c.membershipType]));
  }

  /**
   * Abre (ou recupera) uma conversa 1:1 com um usuário.
   * userId aceita tanto o AAD Object ID (vindo do Microsoft Graph) quanto o id
   * Teams já no formato "29:xxx" (vindo do `from.id` de uma activity recebida) —
   * o Bot Framework aceita os dois como member id sem prefixo artificial.
   * Requer que o bot já tenha recebido ao menos uma atividade (para ter um serviceUrl cacheado)
   * e que esteja instalado no escopo pessoal desse usuário.
   */
  async openDM(userId: string): Promise<string> {
    const serviceUrl = this.defaultServiceUrl;
    if (!serviceUrl) {
      throw new Error(
        'Teams: nenhum serviceUrl cacheado. ' +
          'O bot precisa ter recebido ao menos uma atividade antes de abrir DMs proativos.',
      );
    }

    const body: Record<string, unknown> = {
      bot: { id: `28:${this.config.appId}`, name: 'Bot' },
      members: [{ id: userId }],
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
    this.saveState();

    return raw.id;
  }

  // ── Provisionamento via Microsoft Graph ─────────────────────────────────────
  // Não faz parte da interface ChannelProvider: instalar um app para um usuário
  // é um conceito de administração do tenant, sem equivalente nos outros canais.
  // Ver docs/learnings.md (seção Microsoft Teams) para o porquê dessa fricção.

  /**
   * Lista todos os usuários do tenant (id, nome, e-mail/UPN) via Microsoft Graph.
   * Requer permissão de aplicativo `User.Read.All` com consentimento de admin.
   */
  async listOrgUsers(): Promise<
    Array<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>
  > {
    type GraphUser = {
      id: string;
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
    };

    const users: GraphUser[] = [];
    let url: string | undefined =
      'https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName';

    while (url) {
      const token = await this.getGraphAccessToken();
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        throw new Error(`Teams Graph GET /users → ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as { value: GraphUser[]; '@odata.nextLink'?: string };
      users.push(...json.value);
      url = json['@odata.nextLink'];
    }

    return users;
  }

  /**
   * Instala um app do catálogo do tenant no escopo pessoal de um usuário (sem o
   * usuário precisar abrir o Teams e adicionar manualmente).
   * `userId` aceita o id (AAD Object ID) ou o userPrincipalName do usuário.
   * `teamsAppCatalogId` é o id do app em `appCatalogs/teamsApps` (diferente do
   * Application ID do App Registration) — só apps já publicados no catálogo do
   * tenant podem ser instalados por essa via.
   * Requer permissão de aplicativo `TeamsAppInstallation.ReadWriteForUser.All`.
   */
  async installApp(userId: string, teamsAppCatalogId: string): Promise<void> {
    const token = await this.getGraphAccessToken();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(userId)}/teamwork/installedApps`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        'teamsApp@odata.bind': `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${teamsAppCatalogId}`,
      }),
    });

    if (!res.ok) {
      throw new Error(`Teams Graph POST installedApps → ${res.status}: ${await res.text()}`);
    }
  }

  // ── Change notifications (Microsoft Graph) ──────────────────────────────────
  // Segundo protocolo de entrega de evento, paralelo ao Bot Framework Activity usado em
  // parseWebhook(): o Connector só entrega activity de canal quando o bot é @mencionado
  // (ver docs/learnings.md, item 1) — replies "soltas" numa thread nunca chegam por ali.
  // Assinar `/teams/{teamId}/channels/{channelId}/messages` via Graph capta TUDO, ao custo
  // de um handshake/validação e um shape de mensagem totalmente diferentes. Fica de fora
  // de ChannelProvider de propósito — não dá pra expressar "dois webhooks para um canal"
  // na interface agnóstica sem forçar os outros providers a saber disso.

  /**
   * Cria (ou reaproveita, se já existir) uma assinatura de change notification para todas
   * as mensagens de um canal — inclusive replies sem @menção. `destinationId` é o mesmo id
   * sintético `channel:<teamId>|<channelId>` usado em listDestinations()/send().
   * Requer permissão de aplicativo `ChannelMessage.Read.All` e `PUBLIC_BASE_URL` configurado
   * (o Graph valida a URL de callback de forma síncrona na criação — o servidor precisa
   * estar acessível publicamente *antes* de chamar isto).
   */
  async subscribeToChannelMessages(
    destinationId: string,
  ): Promise<{ subscriptionId: string; expirationDateTime: string }> {
    if (!destinationId.startsWith('channel:')) {
      throw new Error(`Teams: subscribeToChannelMessages espera um destino "channel:...", recebeu "${destinationId}"`);
    }
    const [teamId, channelId] = splitCompositeId(destinationId.slice('channel:'.length));
    const key = `${teamId}|${channelId}`;

    // 'created,updated': 'created' captura mensagens novas e replies; 'updated' captura
    // reações (que são atualizações do chatMessage, não novas entidades)
    const requiredChangeType = 'created,updated';

    const existing = this.channelSubscriptions.get(key);
    if (existing && (existing.changeType ?? 'created') === requiredChangeType) return existing;

    // O Graph exige o Azure AD Group ID (GUID) como teamId — não o thread ID (19:xxx@thread.tacv2)
    // que às vezes vem em channelData.team.id. Usa o aadGroupId capturado das activities quando
    // disponível; caso contrário, resolve via Bot Framework Connector (GET /v3/teams/{id}) ou Graph beta.
    let graphTeamId = this.teamAadGroupIds.get(teamId) ?? teamId;
    if (!isGuid(graphTeamId)) {
      graphTeamId = await this.resolveTeamAadGroupId(teamId) ?? teamId;
    }
    if (!isGuid(graphTeamId)) {
      throw new Error(
        `Teams: não foi possível resolver o Azure AD Group ID (GUID) para o team "${teamId}". ` +
        `Verifique se o bot está instalado no team e se o serviceUrl está disponível.`,
      );
    }

    if (!this.config.publicBaseUrl) {
      throw new Error(
        'Teams: PUBLIC_BASE_URL não configurado — necessário para o Graph saber onde entregar ' +
          'as change notifications (ver docs/learnings.md, Microsoft Teams).',
      );
    }
    if (!this.graphClientState) {
      this.graphClientState = randomBytes(24).toString('hex');
    }

    // Remove trailing slash para evitar double-slash na URL de callback
    const baseUrl = this.config.publicBaseUrl.replace(/\/+$/, '');
    const callbackUrl = `${baseUrl}/webhooks/teams-graph`;

    // Self-test: confirma que o endpoint de callback está acessível VIA URL pública antes de
    // enviar a notificationUrl para o Graph. O Graph faz exatamente essa mesma requisição
    // (POST ?validationToken=X) de forma síncrona durante a criação — se o self-test falhar,
    // o Graph também vai falhar, e temos diagnóstico antes de desperdiçar uma chamada de API.
    const selfTestToken = `self-${randomBytes(6).toString('hex')}`;
    let selfTestOk = false;
    try {
      const selfRes = await fetch(`${callbackUrl}?validationToken=${selfTestToken}`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
      });
      const selfBody = (await selfRes.text()).trim();
      selfTestOk = selfRes.ok && selfBody === selfTestToken;
    } catch {
      // continua — o erro vai aparecer na mensagem abaixo
    }

    if (!selfTestOk) {
      throw new Error(
        `Teams: endpoint de callback não respondeu corretamente em ${callbackUrl}\n` +
        `PUBLIC_BASE_URL configurado: ${this.config.publicBaseUrl}\n` +
        `Confirme que ngrok está ativo para essa URL e que o servidor está exposto publicamente.`,
      );
    }

    const token = await this.getGraphAccessToken();
    const expirationDateTime = new Date(Date.now() + 58 * 60 * 1000).toISOString();

    const res = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        changeType: requiredChangeType,
        resource: `teams/${graphTeamId}/channels/${channelId}/messages`,
        notificationUrl: callbackUrl,
        expirationDateTime,
        clientState: this.graphClientState,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(
        `Teams Graph POST /subscriptions → ${res.status}: ${detail}\n` +
        `notificationUrl: ${callbackUrl}`,
      );
    }

    const raw = (await res.json()) as { id: string; expirationDateTime: string };
    const subscription = { subscriptionId: raw.id, expirationDateTime: raw.expirationDateTime, changeType: requiredChangeType };

    // Apaga a assinatura antiga do Graph só depois de confirmar que a nova foi criada —
    // se a criação falhasse antes (erro acima), a antiga permaneceria ativa no cache
    if (existing) {
      await this.deleteGraphSubscription(existing.subscriptionId);
    }

    this.channelSubscriptions.set(key, subscription);
    this.saveState();

    return subscription;
  }

  /** Deleta uma assinatura no Graph (best-effort — ignora 404 e erros de rede). */
  private async deleteGraphSubscription(subscriptionId: string): Promise<void> {
    try {
      const token = await this.getGraphAccessToken();
      await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // best-effort — se já expirou ou foi deletada, não interfere na recriação
    }
  }

  /** Renova (best-effort) toda assinatura próxima de expirar — chamado pelo timer de start(). */
  private async renewChannelSubscriptions(): Promise<void> {
    const renewBefore = Date.now() + 25 * 60 * 1000;

    for (const [key, sub] of this.channelSubscriptions) {
      if (new Date(sub.expirationDateTime).getTime() > renewBefore) continue;

      try {
        const token = await this.getGraphAccessToken();
        const expirationDateTime = new Date(Date.now() + 58 * 60 * 1000).toISOString();
        const res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sub.subscriptionId}`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ expirationDateTime }),
        });

        if (res.status === 404) {
          // Assinatura já expirou no Graph antes da renovação rodar — não tem o que renovar,
          // só descartar; um novo subscribeToChannelMessages() recria do zero se necessário.
          this.channelSubscriptions.delete(key);
          continue;
        }
        if (!res.ok) {
          throw new Error(`Teams Graph PATCH /subscriptions/${sub.subscriptionId} → ${res.status}: ${await res.text()}`);
        }

        const raw = (await res.json()) as { expirationDateTime: string };
        this.channelSubscriptions.set(key, { ...sub, expirationDateTime: raw.expirationDateTime });
      } catch (err) {
        this.log?.warn('Teams: falha ao renovar assinatura de canal', { key, err: String(err) });
      }
    }

    this.saveState();
  }

  /** Confere se uma notificação realmente veio do Graph (clientState compartilhado na criação). */
  verifyGraphClientState(body: unknown): boolean {
    const parsed = graphNotificationBodySchema.safeParse(body);
    if (!parsed.success || !this.graphClientState) return false;
    return parsed.data.value.every((entry) => entry.clientState === this.graphClientState);
  }

  /**
   * Traduz uma change notification do Graph em eventos agnósticos. Cada entrada só traz um
   * ponteiro (`resource`) — o conteúdo exige um GET adicional ao Graph antes de traduzir.
   * IDs montados para colidir de propósito com o formato do Bot Framework (`docs/learnings.md`,
   * item 3): `${channelId};messageid=${rootId}` é o mesmo conversationId que uma activity
   * mencionada geraria — então uma mesma mensagem captada pelos dois caminhos dedupe sozinha
   * via UNIQUE(provider_message_id) no store.
   */
  async handleGraphNotification(body: unknown): Promise<InboundEvent[]> {
    if (!this.verifyGraphClientState(body)) return [];

    const { value } = graphNotificationBodySchema.parse(body);
    const events: InboundEvent[] = [];

    for (const entry of value) {
      if (entry.changeType !== 'created' && entry.changeType !== 'updated') continue;

      const parsedResource = parseGraphResource(entry.resource);
      if (!parsedResource) continue;
      const { teamId: notifTeamId, channelId, rootMessageId, replyMessageId } = parsedResource;

      // Usa formato REST limpo (sem notação OData) para evitar ambiguidade do '@' em
      // channelId ('19:xxx@thread.tacv2') dentro de chaves OData ('...') que o servidor
      // Graph pode interpretar como anotação OData em vez de parte do valor.
      const graphPath = replyMessageId
        ? `teams/${notifTeamId}/channels/${channelId}/messages/${rootMessageId}/replies/${replyMessageId}`
        : `teams/${notifTeamId}/channels/${channelId}/messages/${rootMessageId}`;

      let raw: GraphChatMessage;
      try {
        raw = await this.fetchGraphResource(graphPath);
      } catch (err) {
        this.log?.error('Teams: falha ao buscar mensagem da change notification', { resource: entry.resource, graphPath, err: String(err) });
        continue;
      }

      const conversationId = `${channelId};messageid=${rootMessageId}`;
      const messageId = replyMessageId ?? rootMessageId;
      const providerMessageId = `${conversationId}|${messageId}`;

      if (entry.changeType === 'created') {
        // Mensagens do próprio bot vêm com from.application (sem from.user) — ignora, evita loop.
        // O check é só para 'created': para 'updated' (reações), o from é do autor da mensagem
        // alvo (pode ser o bot), não do reactor — reactor está em reactions[i].user.user.id.
        if (!raw.from?.user) continue;
        const text = htmlToPlainText(raw.body.content);
        if (!text) continue;

        events.push({
          kind: 'message',
          message: {
            providerMessageId,
            // AAD Object ID, não o "29:..." que vem das activities do Bot Framework para a
            // mesma pessoa — namespaces de id diferentes entre os dois protocolos, sem ponte
            // simples disponível (ver docs/learnings.md, Microsoft Teams).
            from: raw.from.user.id,
            timestamp: raw.createdDateTime ? new Date(raw.createdDateTime) : new Date(),
            content: { kind: 'text', text },
            ...(replyMessageId ? { replyTo: `${conversationId}|${rootMessageId}` } : {}),
            raw,
          },
        });
      } else if (entry.changeType === 'updated' && raw.reactions && raw.reactions.length > 0) {
        // 'updated' chega quando alguém reage a uma mensagem — o campo `reactions[]` traz
        // o snapshot atual de todas as reações. Cada (reactor, emoji, mensagem) gera um
        // evento com ID sintético estável; INSERT OR IGNORE absorve reentregas da mesma reação.
        // Remoção de reação não é detectável com este modelo — limitação aceita no lab.
        for (const reaction of raw.reactions) {
          const reactorId = reaction.user?.user?.id;
          if (!reactorId) continue;
          events.push({
            kind: 'message',
            message: {
              providerMessageId: `rxn:graph:${reactorId}:${conversationId}:${messageId}:${reaction.reactionType}`,
              from: reactorId,
              timestamp: reaction.createdDateTime ? new Date(reaction.createdDateTime) : new Date(),
              content: {
                kind: 'reaction',
                targetMessageId: providerMessageId,
                emoji: reaction.reactionType,
              },
              raw: reaction,
            },
          });
        }
      }
    }

    return events;
  }

  /**
   * Resolve o Azure AD Group ID (GUID) para um team a partir do seu thread ID.
   * Tenta primeiro o Bot Framework Connector (GET /v3/teams/{id}), depois o Graph beta API.
   * Armazena o resultado em `teamAadGroupIds` para chamadas futuras.
   */
  private async resolveTeamAadGroupId(threadId: string): Promise<string | null> {
    // Tentativa 1: Bot Framework Connector — GET /v3/teams/{teamId} retorna aadGroupId sem
    // permissions extras, usando o mesmo token que já usamos para listar canais
    const serviceUrl = this.defaultServiceUrl;
    if (serviceUrl) {
      try {
        const token = await this.getAccessToken();
        const res = await fetch(
          `${normalizeServiceUrl(serviceUrl)}/v3/teams/${encodeURIComponent(threadId)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (res.ok) {
          const json = (await res.json()) as { aadGroupId?: string };
          if (json.aadGroupId && isGuid(json.aadGroupId)) {
            this.teamAadGroupIds.set(threadId, json.aadGroupId);
            this.saveState();
            this.log?.info(`Teams: aadGroupId resolvido via Connector para "${threadId}": ${json.aadGroupId}`);
            return json.aadGroupId;
          }
        }
      } catch {
        // continua para o fallback
      }
    }

    // Tentativa 2: Graph beta API (requer Team.ReadBasic.All)
    try {
      const token = await this.getGraphAccessToken();
      const res = await fetch(
        `https://graph.microsoft.com/beta/teams?$filter=internalId eq '${encodeURIComponent(threadId)}'&$select=id`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        const json = (await res.json()) as { value: Array<{ id: string }> };
        const aadGroupId = json.value[0]?.id;
        if (aadGroupId && isGuid(aadGroupId)) {
          this.teamAadGroupIds.set(threadId, aadGroupId);
          this.saveState();
          this.log?.info(`Teams: aadGroupId resolvido via Graph beta para "${threadId}": ${aadGroupId}`);
          return aadGroupId;
        }
      }
    } catch {
      // sem fallback disponível
    }

    return null;
  }

  private async fetchGraphResource(path: string): Promise<GraphChatMessage> {
    const token = await this.getGraphAccessToken();
    const url = `https://graph.microsoft.com/v1.0/${path}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Teams Graph GET ${url} → ${res.status}: ${body}`);
    }
    return graphChatMessageSchema.parse(await res.json());
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

  private async getGraphAccessToken(): Promise<string> {
    if (this.graphAccessToken && Date.now() < this.graphTokenExpiry - 60_000) {
      return this.graphAccessToken;
    }

    // Client credentials para Graph exige o tenant real — 'botframework.com' (usado
    // no token do Bot Framework para apps multi-tenant) não se aplica aqui.
    if (!this.config.tenantId) {
      throw new Error(
        'Teams: TEAMS_TENANT_ID é obrigatório para chamadas ao Microsoft Graph ' +
          '(provisionamento de usuários/apps não é suportado para bots multi-tenant sem tenant fixo)',
      );
    }

    const res = await fetch(`${MICROSOFT_TOKEN_BASE}/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.appId,
        client_secret: this.config.appPassword,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Teams Graph OAuth2: falha ao obter token → ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.graphAccessToken = json.access_token;
    this.graphTokenExpiry = Date.now() + json.expires_in * 1000;

    return this.graphAccessToken;
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

  private loadState(): void {
    if (!this.config.statePath) return;

    let raw: string;
    try {
      raw = readFileSync(this.config.statePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    const state = JSON.parse(raw) as TeamsPersistedState;
    this.serviceUrlCache = new Map(Object.entries(state.serviceUrls));
    this.defaultServiceUrl = state.defaultServiceUrl;
    this.defaultTenantId = state.defaultTenantId;
    // `teamNames`/`graphClientState`/`channelSubscriptions` não existem em arquivos de
    // estado salvos antes dessas propriedades existirem
    this.teamNames = new Map(Object.entries(state.teamNames ?? {}));
    this.graphClientState = state.graphClientState ?? null;
    this.channelSubscriptions = new Map(
      Object.entries(state.channelSubscriptions ?? {}).map(([k, v]) => [
        k,
        { ...v, changeType: v.changeType ?? 'created' },
      ]),
    );
    this.teamAadGroupIds = new Map(Object.entries(state.teamAadGroupIds ?? {}));
  }

  private saveState(): void {
    if (!this.config.statePath) return;

    const state: TeamsPersistedState = {
      serviceUrls: Object.fromEntries(this.serviceUrlCache),
      defaultServiceUrl: this.defaultServiceUrl,
      defaultTenantId: this.defaultTenantId,
      teamNames: Object.fromEntries(this.teamNames),
      graphClientState: this.graphClientState,
      channelSubscriptions: Object.fromEntries(this.channelSubscriptions),
      teamAadGroupIds: Object.fromEntries(this.teamAadGroupIds),
    };

    mkdirSync(dirname(this.config.statePath), { recursive: true });
    writeFileSync(this.config.statePath, JSON.stringify(state, null, 2));
  }

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

/** Verifica se uma string é um GUID no formato padrão (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). */
function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Extrai team/channel/mensagem do `resource` de uma change notification, ex.:
 * "teams('T')/channels('C')/messages('ROOT')" (post novo) ou
 * "teams('T')/channels('C')/messages('ROOT')/replies('REPLY')" (reply numa thread).
 */
function parseGraphResource(
  resource: string,
): { teamId: string; channelId: string; rootMessageId: string; replyMessageId: string | null } | null {
  const match = /teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)(?:\/replies\('([^']+)'\))?/.exec(
    resource,
  );
  if (!match) return null;
  const [, teamId, channelId, rootMessageId, replyMessageId] = match as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  return { teamId, channelId, rootMessageId, replyMessageId: replyMessageId ?? null };
}

/**
 * Conversão simplificada do corpo HTML do chatMessage (Graph) para texto puro — sem
 * dependência de parser de HTML, suficiente para o laboratório. Não trata formatação
 * rica (listas, tabelas, menções inline) — registrado como simplificação conhecida em
 * docs/learnings.md.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
