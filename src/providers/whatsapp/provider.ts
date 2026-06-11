import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelProvider } from '../../core/provider.js';
import type {
  InboundEvent,
  MediaType,
  MessageContent,
  OutboundMessage,
  SendResult,
} from '../../core/types.js';
import { webhookPayloadSchema, type WebhookMessage, type WebhookStatus } from './payloads.js';

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  apiVersion: string;
  /** sobrescritível em testes */
  baseUrl?: string | undefined;
}

const MEDIA_TYPES: readonly MediaType[] = ['image', 'audio', 'video', 'document', 'sticker'];

export class WhatsAppProvider implements ChannelProvider {
  readonly channel = 'whatsapp' as const;

  constructor(private readonly config: WhatsAppConfig) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const raw = await this.postMessages(toApiPayload(message));

    const providerMessageId = (raw as { messages?: Array<{ id?: string }> } | null)?.messages?.[0]
      ?.id;
    if (!providerMessageId) {
      throw new Error(`Resposta da API sem message id: ${JSON.stringify(raw)}`);
    }

    return { providerMessageId, raw };
  }

  async markAsRead(providerMessageId: string): Promise<void> {
    await this.postMessages({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: providerMessageId,
    });
  }

  private async postMessages(payload: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this.config.baseUrl ?? 'https://graph.facebook.com';
    const url = `${baseUrl}/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }

    if (!response.ok) {
      throw new Error(`WhatsApp API respondeu ${response.status}: ${text}`);
    }

    return raw;
  }

  handleVerification(query: Record<string, unknown>): string | null {
    if (
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] === this.config.verifyToken &&
      typeof query['hub.challenge'] === 'string'
    ) {
      return query['hub.challenge'];
    }
    return null;
  }

  verifySignature(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const header = headers['x-hub-signature-256'];
    if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;

    const expected = Buffer.from(
      createHmac('sha256', this.config.appSecret).update(rawBody).digest('hex'),
      'hex',
    );
    const received = Buffer.from(header.slice('sha256='.length), 'hex');
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  parseWebhook(body: unknown): InboundEvent[] {
    const parsed = webhookPayloadSchema.safeParse(body);
    if (!parsed.success) return [{ kind: 'unknown', raw: body }];

    const events: InboundEvent[] = [];
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') {
          events.push({ kind: 'unknown', raw: change });
          continue;
        }
        for (const message of change.value.messages ?? []) {
          events.push({
            kind: 'message',
            message: {
              providerMessageId: message.id,
              from: message.from,
              timestamp: epochToDate(message.timestamp),
              content: toContent(message),
              ...(message.context?.id ? { replyTo: message.context.id } : {}),
              raw: message,
            },
          });
        }
        for (const status of change.value.statuses ?? []) {
          events.push({ kind: 'status', status: toStatusUpdate(status) });
        }
      }
    }
    return events;
  }
}

function toApiPayload(message: OutboundMessage): Record<string, unknown> {
  const payload = contentToApiPayload(message);
  // context.message_id transforma o envio em reply citando a mensagem original
  return message.replyTo ? { ...payload, context: { message_id: message.replyTo } } : payload;
}

function contentToApiPayload(message: OutboundMessage): Record<string, unknown> {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizeBrazilianMobile(message.to),
  };
  const content = message.content;

  switch (content.kind) {
    case 'text':
      return { ...base, type: 'text', text: { body: content.text } };

    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: content.name,
          language: { code: content.language },
          ...(content.variables?.length
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: content.variables.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      };

    case 'media': {
      if (!content.mediaId && !content.url) {
        throw new Error('Mensagem de mídia exige mediaId ou url');
      }
      return {
        ...base,
        type: content.mediaType,
        [content.mediaType]: {
          ...(content.mediaId ? { id: content.mediaId } : { link: content.url }),
          ...(content.caption ? { caption: content.caption } : {}),
        },
      };
    }

    case 'reaction':
      return {
        ...base,
        type: 'reaction',
        // emoji vazio remove a reação
        reaction: { message_id: content.targetMessageId, emoji: content.emoji ?? '' },
      };

    default:
      throw new Error(`Conteúdo não suportado para envio: ${content.kind}`);
  }
}

function toContent(message: WebhookMessage): MessageContent {
  if (message.type === 'text') {
    return { kind: 'text', text: message.text?.body ?? '' };
  }
  if ((MEDIA_TYPES as readonly string[]).includes(message.type)) {
    const mediaType = message.type as MediaType;
    const media = message[mediaType];
    return {
      kind: 'media',
      mediaType,
      ...(media?.id ? { mediaId: media.id } : {}),
      ...(media?.caption ? { caption: media.caption } : {}),
    };
  }
  if (message.type === 'reaction' && message.reaction) {
    return {
      kind: 'reaction',
      targetMessageId: message.reaction.message_id,
      ...(message.reaction.emoji ? { emoji: message.reaction.emoji } : {}),
    };
  }
  if (message.type === 'location' && message.location) {
    return {
      kind: 'location',
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      ...(message.location.name ? { name: message.location.name } : {}),
      ...(message.location.address ? { address: message.location.address } : {}),
    };
  }
  if (message.type === 'contacts' && message.contacts) {
    return {
      kind: 'contacts',
      contacts: message.contacts.map((contact) => ({
        ...(contact.name?.formatted_name ? { name: contact.name.formatted_name } : {}),
        phones: (contact.phones ?? [])
          .map((phone) => phone.phone ?? phone.wa_id)
          .filter((phone): phone is string => Boolean(phone)),
      })),
    };
  }
  if (message.type === 'interactive' && message.interactive) {
    const reply = message.interactive.button_reply ?? message.interactive.list_reply;
    if (reply) {
      return {
        kind: 'choice',
        choiceId: reply.id,
        label: reply.title,
        source: message.interactive.button_reply ? 'button' : 'list',
      };
    }
  }
  if (message.type === 'button' && message.button) {
    return {
      kind: 'choice',
      choiceId: message.button.payload ?? message.button.text ?? '',
      label: message.button.text ?? '',
      source: 'template_button',
    };
  }
  // inclui mensagens apagadas pelo usuário e tipos sem suporte (polls, efêmeras) — errors fica no raw
  return { kind: 'unsupported', nativeType: message.type };
}

function toStatusUpdate(status: WebhookStatus) {
  const firstError = status.errors?.[0];
  return {
    providerMessageId: status.id,
    recipient: status.recipient_id,
    status: status.status,
    timestamp: epochToDate(status.timestamp),
    error: firstError
      ? { code: firstError.code, detail: firstError.message ?? firstError.title ?? 'unknown' }
      : undefined,
    raw: status,
  };
}

function epochToDate(seconds: string): Date {
  return new Date(Number(seconds) * 1000);
}

/**
 * O wa_id de celulares brasileiros antigos vem SEM o nono dígito (55 + DDD + 8 dígitos),
 * mas a lista de permissão/envio da Meta espera o número COM o 9. Sem essa normalização,
 * responder ao `from` de um webhook falha com (#131030). Celulares de 8 dígitos começam
 * com 6-9; fixos (2-5) não recebem o 9.
 */
function normalizeBrazilianMobile(to: string): string {
  const digits = to.replace(/\D/g, '');
  const match = /^55(\d{2})([6-9]\d{7})$/.exec(digits);
  return match ? `55${match[1]}9${match[2]}` : digits;
}
