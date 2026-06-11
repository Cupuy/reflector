import type { ChannelId, InboundMessage, OutboundMessage, SendResult, StatusUpdate } from './types.js';

export interface WebhookRequestRecord {
  id: number;
  channel: string;
  receivedAt: string;
  headers: unknown;
  body: string;
  signatureValid: boolean;
}

export interface OutboundRecord {
  id: number;
  channel: string;
  providerMessageId: string;
  recipient: string;
  content: unknown;
  apiResponse: unknown;
  replyTo: string | null;
  sentAt: string;
}

export interface InboundRecord {
  id: number;
  channel: string;
  providerMessageId: string;
  sender: string;
  content: unknown;
  raw: unknown;
  replyTo: string | null;
  webhookRequestId: number;
  receivedAt: string;
}

export interface StatusEventRecord {
  id: number;
  channel: string;
  providerMessageId: string;
  status: string;
  error: unknown;
  webhookRequestId: number;
  occurredAt: string;
}

/**
 * Linha do tempo de uma mensagem enviada: o envio, os status recebidos via webhook,
 * e as interações do usuário com ela (reações e replies citando a mensagem).
 */
export interface MessageTimeline {
  outbound: OutboundRecord;
  statuses: StatusEventRecord[];
  reactions: InboundRecord[];
  replies: InboundRecord[];
  /** reações que NÓS enviamos referenciando esta mensagem (ex.: ⚠️ de correção) */
  outboundReactions: OutboundRecord[];
  /** replies que NÓS enviamos citando esta mensagem (ex.: texto corrigido) */
  outboundReplies: OutboundRecord[];
}

export interface MessageStore {
  saveWebhookRequest(input: {
    channel: ChannelId;
    headers: unknown;
    body: string;
    signatureValid: boolean;
  }): number;

  saveOutbound(input: { channel: ChannelId; message: OutboundMessage; result: SendResult }): void;

  /** Idempotente: reentregas com o mesmo providerMessageId são ignoradas. */
  saveInbound(input: { channel: ChannelId; message: InboundMessage; webhookRequestId: number }): void;

  saveStatusEvent(input: { channel: ChannelId; status: StatusUpdate; webhookRequestId: number }): void;

  getMessageTimeline(providerMessageId: string): MessageTimeline | null;

  listOutbound(limit?: number): OutboundRecord[];
  listInbound(limit?: number): InboundRecord[];
  listWebhookRequests(limit?: number): WebhookRequestRecord[];
}
