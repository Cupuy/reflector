import type { ChannelId, InboundEvent, OutboundMessage, SendResult } from './types.js';

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
}
