import { z } from 'zod';

const mediaObjectSchema = z
  .object({
    id: z.string(),
    caption: z.string().optional(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
  })
  .passthrough();

const errorSchema = z
  .object({
    code: z.union([z.number(), z.string()]),
    title: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const webhookMessageSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    timestamp: z.string(),
    type: z.string(),
    // presente quando a mensagem é uma resposta (reply) citando outra
    context: z.object({ id: z.string().optional(), from: z.string().optional() }).passthrough().optional(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaObjectSchema.optional(),
    audio: mediaObjectSchema.optional(),
    video: mediaObjectSchema.optional(),
    document: mediaObjectSchema.optional(),
    sticker: mediaObjectSchema.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
    contacts: z
      .array(
        z
          .object({
            name: z.object({ formatted_name: z.string().optional() }).passthrough().optional(),
            phones: z
              .array(
                z.object({ phone: z.string().optional(), wa_id: z.string().optional() }).passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    reaction: z.object({ message_id: z.string(), emoji: z.string().optional() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z
          .object({ id: z.string(), title: z.string(), description: z.string().optional() })
          .optional(),
      })
      .passthrough()
      .optional(),
    button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
    // mensagens apagadas/não suportadas chegam como type "unsupported" com errors
    errors: z.array(errorSchema).optional(),
  })
  .passthrough();

export const webhookStatusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string(),
    errors: z.array(errorSchema).optional(),
  })
  .passthrough();

export const webhookPayloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              messages: z.array(webhookMessageSchema).optional(),
              statuses: z.array(webhookStatusSchema).optional(),
            })
            .passthrough(),
        }),
      ),
    }),
  ),
});

export type WebhookMessage = z.infer<typeof webhookMessageSchema>;
export type WebhookStatus = z.infer<typeof webhookStatusSchema>;
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
