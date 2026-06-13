import { z } from 'zod';

export const discordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  bot: z.boolean().optional(),
});

export const discordAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  content_type: z.string().optional(),
  url: z.string(),
  size: z.number(),
});

export const discordStickerItemSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const discordMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  author: discordUserSchema.optional(),
  content: z.string().default(''),
  timestamp: z.string(),
  attachments: z.array(discordAttachmentSchema).default([]),
  embeds: z.array(z.unknown()).default([]),
  message_reference: z
    .object({ message_id: z.string().optional(), channel_id: z.string().optional() })
    .optional(),
  type: z.number().default(0),
  sticker_items: z.array(discordStickerItemSchema).optional(),
});

export type DiscordMessage = z.infer<typeof discordMessageSchema>;

export const discordReactionEventSchema = z.object({
  user_id: z.string(),
  channel_id: z.string(),
  message_id: z.string(),
  guild_id: z.string().optional(),
  emoji: z.object({ id: z.string().nullable(), name: z.string().nullable() }),
});

export type DiscordReactionEvent = z.infer<typeof discordReactionEventSchema>;

export const discordMessageDeleteSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
});

// Payload do Interactions endpoint (POST /webhooks/discord)
// type=1: PING, type=2: APPLICATION_COMMAND, type=3: MESSAGE_COMPONENT, etc.
export const discordInteractionSchema = z.object({
  type: z.number(),
  id: z.string().optional(),
  token: z.string().optional(),
  data: z.unknown().optional(),
});

export type DiscordInteraction = z.infer<typeof discordInteractionSchema>;
