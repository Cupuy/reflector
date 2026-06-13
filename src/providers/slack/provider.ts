import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelProvider } from '../../core/provider.js';
import type { InboundEvent, OutboundMessage, SendResult } from '../../core/types.js';
import { slackMessageEventSchema, slackWebhookSchema } from './payloads.js';

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
}

const API_BASE = 'https://slack.com/api';

export class SlackProvider implements ChannelProvider {
  readonly channel = 'slack' as const;

  constructor(private readonly config: SlackConfig) {}

  // ── Verificação ────────────────────────────────────────────────────────────

  handleVerification(_query: Record<string, unknown>): string | null {
    // Slack não usa GET para handshake — a URL verification chega como POST
    return null;
  }

  handleWebhookChallenge(body: unknown): string | null {
    if (
      body !== null &&
      typeof body === 'object' &&
      (body as Record<string, unknown>)['type'] === 'url_verification'
    ) {
      const challenge = (body as Record<string, unknown>)['challenge'];
      return typeof challenge === 'string' ? challenge : null;
    }
    return null;
  }

  verifySignature(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const signature = headers['x-slack-signature'];
    const timestamp = headers['x-slack-request-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') return false;

    // Rejeita requests com mais de 5 minutos (anti-replay)
    const ts = parseInt(timestamp, 10);
    if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const baseString = `v0:${timestamp}:${body}`;
    const expected = 'v0=' + createHmac('sha256', this.config.signingSecret).update(baseString).digest('hex');

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ── Tradução de eventos ────────────────────────────────────────────────────

  parseWebhook(body: unknown): InboundEvent[] {
    const parsed = slackWebhookSchema.safeParse(body);
    if (!parsed.success) return [{ kind: 'unknown', raw: body }];

    const data = parsed.data;

    // url_verification é tratado de forma síncrona em handleWebhookChallenge
    if (data.type === 'url_verification') return [];

    if (data.type === 'event_callback') {
      const eventParsed = slackMessageEventSchema.safeParse(data.event);
      if (!eventParsed.success) return [{ kind: 'unknown', raw: body }];

      const event = eventParsed.data;

      // Ignora mensagens de bots (inclusive do próprio app) e eventos com subtipo
      // (edições, deleções) — mapeados como unknown por enquanto
      if (event.subtype !== undefined || event.bot_id !== undefined || !event.user) {
        return [{ kind: 'unknown', raw: body }];
      }

      return [
        {
          kind: 'message',
          message: {
            providerMessageId: `${event.channel}:${event.ts}`,
            from: event.user,
            timestamp: new Date(parseFloat(event.ts) * 1000),
            content: { kind: 'text', text: event.text ?? '' },
            ...(event.thread_ts && event.thread_ts !== event.ts
              ? { replyTo: `${event.channel}:${event.thread_ts}` }
              : {}),
            raw: body,
          },
        },
      ];
    }

    return [{ kind: 'unknown', raw: body }];
  }

  // ── Envio ──────────────────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    const content = message.content;

    if (content.kind === 'reaction') {
      const [channel, ts] = splitCompositeId(content.targetMessageId);
      if (!content.emoji) throw new Error('Slack: emoji é obrigatório para reações');
      const name = normalizeEmojiName(content.emoji);
      await this.api('reactions.add', { channel, timestamp: ts, name });
      return { providerMessageId: `rxn:${channel}:${ts}:${name}`, raw: { ok: true } };
    }

    const payload: Record<string, unknown> = { channel: message.to };

    // Replies no Slack usam thread_ts (o ts da mensagem-raiz do thread)
    if (message.replyTo !== undefined) {
      const [, replyTs] = splitCompositeId(message.replyTo);
      payload['thread_ts'] = replyTs;
    }

    switch (content.kind) {
      case 'text':
        payload['text'] = content.text;
        break;

      case 'media':
        if (content.url !== undefined) {
          payload['blocks'] = [
            {
              type: 'image',
              image_url: content.url,
              alt_text: content.caption ?? content.mediaType ?? 'image',
            },
          ];
          if (content.caption) payload['text'] = content.caption;
        } else {
          throw new Error('Slack: envio de mídia exige url — upload direto de arquivo não suportado aqui');
        }
        break;

      default:
        throw new Error(`Slack: kind "${(content as { kind: string }).kind}" não suportado para envio`);
    }

    const raw = await this.api<{ ts: string; channel: string }>('chat.postMessage', payload);
    return { providerMessageId: `${raw.channel}:${raw.ts}`, raw };
  }

  async markAsRead(providerMessageId: string): Promise<void> {
    const [channel, ts] = splitCompositeId(providerMessageId);
    await this.api('conversations.mark', { channel, ts });
  }

  // ── Edição e exclusão ──────────────────────────────────────────────────────

  async editMessage(providerMessageId: string, text: string): Promise<void> {
    const [channel, ts] = splitCompositeId(providerMessageId);
    await this.api('chat.update', { channel, ts, text });
  }

  async deleteMessage(providerMessageId: string): Promise<void> {
    const [channel, ts] = splitCompositeId(providerMessageId);
    await this.api('chat.delete', { channel, ts });
  }

  // ── Destinos disponíveis ───────────────────────────────────────────────────

  async listDestinations(): Promise<Array<{ id: string; label: string; group?: string }>> {
    const result = await this.api<{
      channels: Array<{
        id: string;
        name?: string;
        is_im: boolean;
        is_private: boolean;
        user?: string;
      }>;
    }>('conversations.list', {
      types: 'public_channel,private_channel,im,mpim',
      limit: 200,
      exclude_archived: true,
    });

    return result.channels.map((ch) => {
      if (ch.is_im) {
        return { id: ch.id, label: `@${ch.user ?? ch.id}`, group: 'DMs' };
      }
      return {
        id: ch.id,
        label: `#${ch.name ?? ch.id}`,
        group: ch.is_private ? 'Privados' : 'Canais',
      };
    });
  }

  // ── Interno ────────────────────────────────────────────────────────────────

  private async api<T = unknown>(method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body ?? {}),
    });

    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) {
      throw new Error(`Slack API ${method} → erro: ${json.error ?? 'desconhecido'}`);
    }
    return json as T;
  }
}

function splitCompositeId(id: string): [channel: string, ts: string] {
  const idx = id.indexOf(':');
  if (idx === -1) throw new Error(`providerMessageId Slack inválido (sem ':'): ${id}`);
  return [id.slice(0, idx), id.slice(idx + 1)];
}

/** Normaliza emoji para nome do Slack: ':thumbsup:' → 'thumbsup'. */
function normalizeEmojiName(emoji: string): string {
  return emoji.replace(/^:|:$/g, '');
}
