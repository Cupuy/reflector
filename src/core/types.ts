export type ChannelId = 'whatsapp' | 'discord' | 'slack';

export type MediaType = 'image' | 'audio' | 'video' | 'document' | 'sticker';

export type MessageContent =
  | { kind: 'text'; text: string }
  | { kind: 'template'; name: string; language: string; variables?: string[] | undefined }
  | {
      kind: 'media';
      mediaType: MediaType;
      /** id de mídia já hospedada no provider */
      mediaId?: string | undefined;
      /** URL pública para o provider baixar */
      url?: string | undefined;
      caption?: string | undefined;
    }
  | {
      kind: 'location';
      latitude: number;
      longitude: number;
      name?: string | undefined;
      address?: string | undefined;
    }
  | { kind: 'contacts'; contacts: Array<{ name?: string | undefined; phones: string[] }> }
  | {
      kind: 'reaction';
      /** wamid da mensagem reagida — pode ser uma mensagem enviada por nós */
      targetMessageId: string;
      /** ausente = reação removida */
      emoji?: string | undefined;
    }
  | {
      /** resposta a botão, lista ou quick-reply de template — unificados como "escolha" */
      kind: 'choice';
      choiceId: string;
      label: string;
      source: 'button' | 'list' | 'template_button';
    }
  | { kind: 'unsupported'; nativeType: string };

export interface OutboundMessage {
  to: string;
  content: MessageContent;
  /** wamid da mensagem a citar — transforma o envio em resposta (reply) */
  replyTo?: string | undefined;
}

export interface SendResult {
  /** id atribuído pelo canal (ex.: wamid) — chave de correlação com eventos de status */
  providerMessageId: string;
  raw: unknown;
}

export interface InboundMessage {
  providerMessageId: string;
  from: string;
  timestamp: Date;
  content: MessageContent;
  /** wamid da mensagem citada, quando é uma resposta (reply) */
  replyTo?: string | undefined;
  raw: unknown;
}

export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed' | (string & {});

export interface StatusUpdate {
  providerMessageId: string;
  recipient: string;
  status: MessageStatus;
  timestamp: Date;
  error?: { code: string | number; detail: string } | undefined;
  raw: unknown;
}

export type InboundEvent =
  | { kind: 'message'; message: InboundMessage }
  | { kind: 'status'; status: StatusUpdate }
  | { kind: 'unknown'; raw: unknown };
