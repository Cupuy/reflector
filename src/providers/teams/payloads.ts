import { z } from 'zod';

export const teamsChannelAccountSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  aadObjectId: z.string().optional(),
});

export const teamsConversationAccountSchema = z.object({
  id: z.string(),
  isGroup: z.boolean().optional(),
  conversationType: z.string().optional(), // 'personal' | 'channel' | 'groupChat'
  tenantId: z.string().optional(),
  name: z.string().optional(),
});

export const teamsAttachmentSchema = z.object({
  contentType: z.string(),
  contentUrl: z.string().optional(),
  content: z.unknown().optional(),
  name: z.string().optional(),
});

// Reações suportadas pelo Teams: like, heart, laugh, surprised, sad, angry
export const teamsReactionSchema = z.object({
  type: z.string(),
});

export const teamsActivitySchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    timestamp: z.string().optional(),
    serviceUrl: z.string(),
    channelId: z.string().optional(), // sempre "msteams" em produção
    from: teamsChannelAccountSchema.optional(),
    conversation: teamsConversationAccountSchema,
    recipient: teamsChannelAccountSchema.optional(),
    text: z.string().optional(),
    replyToId: z.string().optional(),
    attachments: z.array(teamsAttachmentSchema).default([]),
    // Presentes em activities do tipo messageReaction
    reactionsAdded: z.array(teamsReactionSchema).optional(),
    reactionsRemoved: z.array(teamsReactionSchema).optional(),
    channelData: z
      .object({
        team: z.object({ id: z.string(), name: z.string().optional() }).optional(),
        channel: z.object({ id: z.string() }).optional(),
        tenant: z.object({ id: z.string() }).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type TeamsActivity = z.infer<typeof teamsActivitySchema>;
