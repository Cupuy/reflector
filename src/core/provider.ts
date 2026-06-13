import type { MessageStore } from './store.js';
import type { ChannelId, InboundEvent, OutboundMessage, SendResult } from './types.js';

export interface Logger {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

export interface ChannelProvider {
  readonly channel: ChannelId;

  send(message: OutboundMessage): Promise<SendResult>;

  /** Confirma leitura de uma mensagem recebida (controla o "visto" do nosso lado). */
  markAsRead(providerMessageId: string): Promise<void>;

  /**
   * Fluxo de verificação do webhook (handshake GET).
   * Retorna o corpo a responder em texto puro, ou null se o token não confere.
   */
  handleVerification(query: Record<string, unknown>): string | null;

  verifySignature(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): boolean;

  /** Traduz o payload nativo do webhook em eventos agnósticos de canal. */
  parseWebhook(body: unknown): InboundEvent[];

  /**
   * Opcional: providers que precisam de conexão persistente (ex.: Discord Gateway WebSocket)
   * chamam start() na inicialização para se conectar ao canal.
   */
  start?(context: { store: MessageStore; log: Logger }): Promise<void>;

  /** Para a conexão persistente iniciada por start(). */
  stop?(): Promise<void>;

  /** Opcional: canais que permitem edição de mensagens enviadas (ex.: Discord, Telegram). */
  editMessage?(providerMessageId: string, text: string): Promise<void>;

  /** Opcional: canais que permitem exclusão de mensagens (ex.: Discord, Telegram). */
  deleteMessage?(providerMessageId: string): Promise<void>;

  /**
   * Opcional: retorna os destinos disponíveis para envio neste canal.
   * Discord: servidores + canais de texto. WhatsApp: não implementa (destinatário é livre).
   */
  listDestinations?(): Promise<Array<{ id: string; label: string; group?: string }>>;

  /**
   * Opcional: providers que verificam via POST (ex.: Slack URL verification).
   * Se retornar uma string não-nula, o servidor responde com ela de forma síncrona
   * em vez do 200 vazio padrão — equivalente ao hub.challenge do WhatsApp, mas via POST.
   */
  handleWebhookChallenge?(body: unknown): string | null;
}
