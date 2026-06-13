import { createPublicKey, verify } from 'node:crypto';
import type { ChannelProvider, Logger } from '../../core/provider.js';
import type { MessageStore } from '../../core/store.js';
import type { InboundEvent, OutboundMessage, SendResult } from '../../core/types.js';
import { discordInteractionSchema } from './payloads.js';
import { DiscordGatewayClient } from './gateway.js';

export interface DiscordConfig {
  botToken: string;
  applicationId: string;
  /** Chave pública Ed25519 em hex — usada para verificar o Interactions endpoint. */
  publicKey: string;
}

const API_BASE = 'https://discord.com/api/v10';

export class DiscordProvider implements ChannelProvider {
  readonly channel = 'discord' as const;
  private gateway: DiscordGatewayClient | null = null;

  constructor(private readonly config: DiscordConfig) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(context: { store: MessageStore; log: Logger }): Promise<void> {
    this.gateway = new DiscordGatewayClient(this.config.botToken, context.store, context.log);
    this.gateway.start();
  }

  async stop(): Promise<void> {
    this.gateway?.stop();
    this.gateway = null;
  }

  // ── Interactions endpoint (POST /webhooks/discord) ─────────────────────────

  handleVerification(_query: Record<string, unknown>): string | null {
    // Discord não faz handshake via GET — o PING chega como POST com Ed25519
    return null;
  }

  verifySignature(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') return false;

    try {
      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      const message = Buffer.from(timestamp + body);
      const sigBuf = Buffer.from(signature, 'hex');
      const pubKeyBuf = Buffer.from(this.config.publicKey, 'hex');

      // Node.js 22: montagem de chave Ed25519 via JWK a partir de bytes raw
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: pubKeyBuf.toString('base64url') },
        format: 'jwk',
      });

      return verify(null, message, publicKey, sigBuf);
    } catch {
      return false;
    }
  }

  parseWebhook(body: unknown): InboundEvent[] {
    const parsed = discordInteractionSchema.safeParse(body);
    if (!parsed.success) return [{ kind: 'unknown', raw: body }];

    // type=1 é o PING do Discord para validar a URL de Interactions.
    // O protocolo exige que respondamos { type: 1 } de forma síncrona.
    // FRICÇÃO: o servidor atual envia 200 vazio e processa de forma assíncrona.
    // Essa diferença exige que o servidor suporte resposta customizada por provider
    // antes do auto-reply 200 — anotado em docs/learnings.md para revisão da interface.
    return [{ kind: 'unknown', raw: body }];
  }

  // ── Envio via REST API ──────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const content = message.content;

    // Reações usam PUT em endpoint diferente do de mensagens
    if (content.kind === 'reaction') {
      const [channelId, messageId] = splitCompositeId(content.targetMessageId);
      if (!content.emoji) {
        throw new Error('Discord: especifique um emoji; remoção de reação exige emoji explícito');
      }
      await this.rest('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(content.emoji)}/@me`);
      const syntheticId = `rxn:sent:${channelId}:${messageId}:${content.emoji}`;
      return { providerMessageId: syntheticId, raw: { ok: true } };
    }

    const channelId = message.to; // para Discord, `to` é sempre um channel_id
    const body = this.toMessagePayload(message);
    const raw = await this.rest<{ id: string }>('POST', `/channels/${channelId}/messages`, body);

    return { providerMessageId: `${channelId}:${raw.id}`, raw };
  }

  async markAsRead(_providerMessageId: string): Promise<void> {
    // Discord não expõe "marcar como lida" para bots
  }

  // ── Moderação ───────────────────────────────────────────────────────────────

  async editMessage(providerMessageId: string, text: string): Promise<void> {
    const [channelId, messageId] = splitCompositeId(providerMessageId);
    await this.rest('PATCH', `/channels/${channelId}/messages/${messageId}`, { content: text });
  }

  async deleteMessage(providerMessageId: string): Promise<void> {
    const [channelId, messageId] = splitCompositeId(providerMessageId);
    await this.rest('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  // ── Helper: criar canal de DM a partir de um userId ─────────────────────────

  async createDMChannel(userId: string): Promise<string> {
    const raw = await this.rest<{ id: string }>('POST', '/users/@me/channels', {
      recipient_id: userId,
    });
    return raw.id;
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  private toMessagePayload(message: OutboundMessage): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const content = message.content;

    if (message.replyTo !== undefined) {
      const [, replyMessageId] = splitCompositeId(message.replyTo);
      payload['message_reference'] = { message_id: replyMessageId };
    }

    switch (content.kind) {
      case 'text':
        payload['content'] = content.text;
        break;

      case 'media': {
        if (content.url === undefined) {
          throw new Error('Discord: envio de mídia exige url — media_id não é suportado');
        }
        payload['embeds'] = [
          { image: { url: content.url }, ...(content.caption ? { description: content.caption } : {}) },
        ];
        break;
      }

      default:
        throw new Error(`Discord: kind "${(content as { kind: string }).kind}" não suportado para envio`);
    }

    return payload;
  }

  private async rest<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.config.botToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }

    if (!res.ok) {
      throw new Error(`Discord API ${method} ${path} → ${res.status}: ${text}`);
    }

    return json as T;
  }
}

/**
 * Divide o providerMessageId composto do Discord (channelId:messageId) nos dois componentes.
 * Reações (rxn:...) não devem passar por aqui — são IDs sintéticos sem operação correspondente.
 */
function splitCompositeId(id: string): [channelId: string, messageId: string] {
  const idx = id.indexOf(':');
  if (idx === -1) throw new Error(`providerMessageId Discord inválido (sem ':'): ${id}`);
  return [id.slice(0, idx), id.slice(idx + 1)];
}
