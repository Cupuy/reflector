import { z } from 'zod';

export const slackMessageEventSchema = z.object({
  type: z.literal('message'),
  subtype: z.string().optional(),
  channel: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
  ts: z.string(),
  thread_ts: z.string().optional(),
}).passthrough();

const slackUrlVerification = z.object({
  type: z.literal('url_verification'),
  challenge: z.string(),
  token: z.string().optional(),
});

const slackEventCallback = z.object({
  type: z.literal('event_callback'),
  team_id: z.string().optional(),
  event_id: z.string().optional(),
  event: z.object({ type: z.string() }).passthrough(),
}).passthrough();

export const slackWebhookSchema = z.discriminatedUnion('type', [
  slackUrlVerification,
  slackEventCallback,
]);
