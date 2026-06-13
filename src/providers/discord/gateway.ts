import type { Logger } from '../../core/provider.js';
import type { MessageStore } from '../../core/store.js';
import type { InboundMessage, MessageContent } from '../../core/types.js';
import {
  discordMessageSchema,
  discordReactionEventSchema,
  type DiscordMessage,
  type DiscordReactionEvent,
} from './payloads.js';

// Opcodes do protocolo do Gateway
const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

/**
 * Intents necessários para receber os eventos que queremos explorar.
 * MESSAGE_CONTENT (32768) é privilegiado — precisa ser habilitado no Developer Portal.
 *
 * GUILDS(1) | GUILD_MESSAGES(512) | GUILD_MESSAGE_REACTIONS(1024) |
 * DIRECT_MESSAGES(4096) | DIRECT_MESSAGE_REACTIONS(8192) | MESSAGE_CONTENT(32768)
 */
export const DISCORD_INTENTS = 1 | 512 | 1024 | 4096 | 8192 | 32768;

const GATEWAY_BASE = 'wss://gateway.discord.gg/?v=10&encoding=json';

/**
 * Cliente do Discord Gateway (WebSocket).
 *
 * Diferença arquitetural em relação ao WhatsApp: no Discord, nós nos conectamos ativamente
 * ao Gateway via WebSocket. Os eventos não chegam via POST HTTP ao nosso servidor — é a
 * direção inversa. Por isso o provider precisa de lifecycle (start/stop), diferente do
 * WhatsApp onde o servidor já recebia as requisições passivamente.
 *
 * Os eventos recebidos são persistidos como webhook_requests (para observabilidade) e como
 * inbound_messages (para correlação), exatamente como no fluxo HTTP do WhatsApp.
 */
export class DiscordGatewayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly store: MessageStore,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, 'stop');
    this.ws = null;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    const url = this.resumeUrl ?? GATEWAY_BASE;
    this.log.info('Discord Gateway: conectando');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('message', (event) => {
      try {
        this.handle(JSON.parse((event as unknown as { data: string }).data));
      } catch (err) {
        this.log.error('Discord Gateway: falha ao processar mensagem', { err: String(err) });
      }
    });

    ws.addEventListener('close', (event) => {
      const { code, reason } = event as unknown as { code: number; reason: string };
      this.log.warn(`Discord Gateway: desconectado`, { code, reason });
      this.clearTimers();
      this.ws = null;
      // 4004 = token inválido; 1000 = fechamento intencional — não reconectar
      if (!this.stopped && code !== 4004 && code !== 1000) {
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          5000 + Math.random() * 2000,
        );
      }
    });

    ws.addEventListener('error', () => {
      this.log.error('Discord Gateway: erro de WebSocket');
    });
  }

  private sendOp(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d }));
    }
  }

  private identify(): void {
    this.sendOp(Op.Identify, {
      token: this.token,
      intents: DISCORD_INTENTS,
      properties: { os: 'linux', browser: 'reflector', device: 'reflector' },
    });
  }

  private resume(): void {
    this.sendOp(Op.Resume, {
      token: this.token,
      session_id: this.sessionId,
      seq: this.sequence,
    });
  }

  private handle(payload: unknown): void {
    const p = payload as { op: number; d: unknown; s?: number | null; t?: string | null };
    if (typeof p.s === 'number') this.sequence = p.s;

    switch (p.op) {
      case Op.Hello: {
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
        // Jitter inicial para evitar thundering herd em múltiplas reconexões
        setTimeout(() => this.sendOp(Op.Heartbeat, this.sequence), Math.random() * interval);
        this.heartbeatTimer = setInterval(
          () => this.sendOp(Op.Heartbeat, this.sequence),
          interval,
        );
        this.sessionId !== null ? this.resume() : this.identify();
        break;
      }

      case Op.HeartbeatAck:
        break;

      case Op.Heartbeat:
        this.sendOp(Op.Heartbeat, this.sequence);
        break;

      case Op.Reconnect:
        this.log.info('Discord Gateway: RECONNECT solicitado pelo servidor');
        this.ws?.close();
        break;

      case Op.InvalidSession: {
        const resumable = Boolean(p.d);
        this.log.warn('Discord Gateway: sessão inválida', { resumable });
        if (!resumable) {
          this.sessionId = null;
          this.sequence = null;
          this.resumeUrl = null;
        }
        setTimeout(() => (resumable ? this.resume() : this.identify()), 1500 + Math.random() * 3000);
        break;
      }

      case Op.Dispatch:
        if (typeof p.t === 'string') this.dispatch(p.t, p.d);
        break;
    }
  }

  private dispatch(event: string, data: unknown): void {
    if (event === 'READY') {
      const r = data as { session_id: string; resume_gateway_url: string };
      this.sessionId = r.session_id;
      this.resumeUrl = `${r.resume_gateway_url}?v=10&encoding=json`;
      this.log.info('Discord Gateway: READY');
      return;
    }

    // Persiste TODOS os eventos como webhook_request (matéria-prima do laboratório)
    const webhookRequestId = this.store.saveWebhookRequest({
      channel: 'discord',
      headers: { 'x-gateway-event': event },
      body: JSON.stringify(data),
      // Eventos do Gateway são autenticados por TLS + bot token, sem HMAC
      signatureValid: true,
    });

    switch (event) {
      case 'MESSAGE_CREATE': {
        const parsed = discordMessageSchema.safeParse(data);
        if (!parsed.success) {
          this.log.warn('Discord: MESSAGE_CREATE com schema inesperado', { error: parsed.error });
          return;
        }
        // Ignora mensagens do próprio bot para não criar loops
        if (parsed.data.author?.bot) return;
        const inbound = this.toInboundMessage(parsed.data);
        this.store.saveInbound({ channel: 'discord', message: inbound, webhookRequestId });
        break;
      }

      case 'MESSAGE_REACTION_ADD': {
        const parsed = discordReactionEventSchema.safeParse(data);
        if (!parsed.success) {
          this.log.warn('Discord: REACTION_ADD com schema inesperado', { error: parsed.error });
          return;
        }
        const inbound = this.toReactionMessage(parsed.data);
        this.store.saveInbound({ channel: 'discord', message: inbound, webhookRequestId });
        break;
      }

      // MESSAGE_UPDATE e MESSAGE_DELETE: ficam só no webhook_request (já salvo acima)
      // para observabilidade. Não viram inbound_messages para não confundir a correlação.
    }
  }

  private toInboundMessage(msg: DiscordMessage): InboundMessage {
    // providerMessageId = channelId:messageId — formato composto necessário porque
    // operações na REST API do Discord exigem os dois IDs.
    const providerMessageId = `${msg.channel_id}:${msg.id}`;
    const replyTo =
      msg.message_reference?.message_id !== undefined
        ? `${msg.channel_id}:${msg.message_reference.message_id}`
        : undefined;

    return {
      providerMessageId,
      from: msg.author?.id ?? 'unknown',
      timestamp: new Date(msg.timestamp),
      content: this.toContent(msg),
      replyTo,
      raw: msg,
    };
  }

  private toReactionMessage(r: DiscordReactionEvent): InboundMessage {
    // Reações no Discord não têm ID próprio — composição userId+channelId+messageId+emoji é única
    const emojiStr =
      r.emoji.id !== null
        ? `${r.emoji.name ?? ''}:${r.emoji.id}` // emoji customizado: nome:id
        : (r.emoji.name ?? '?'); // emoji padrão Unicode
    const providerMessageId = `rxn:${r.user_id}:${r.channel_id}:${r.message_id}:${emojiStr}`;

    return {
      providerMessageId,
      from: r.user_id,
      timestamp: new Date(),
      content: {
        kind: 'reaction',
        targetMessageId: `${r.channel_id}:${r.message_id}`,
        emoji: emojiStr,
      },
      raw: r,
    };
  }

  private toContent(msg: DiscordMessage): MessageContent {
    if (msg.content !== '') {
      return { kind: 'text', text: msg.content };
    }
    if (msg.sticker_items !== undefined && msg.sticker_items.length > 0) {
      return { kind: 'media', mediaType: 'sticker', mediaId: msg.sticker_items[0]!.id };
    }
    if (msg.attachments.length > 0) {
      const att = msg.attachments[0]!;
      const mime = att.content_type ?? '';
      const mediaType = mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : mime.startsWith('audio/')
            ? 'audio'
            : 'document';
      return { kind: 'media', mediaType, url: att.url, caption: att.filename };
    }
    if (msg.embeds.length > 0) {
      return { kind: 'unsupported', nativeType: 'embed' };
    }
    return { kind: 'unsupported', nativeType: `discord_message_type_${msg.type}` };
  }
}
