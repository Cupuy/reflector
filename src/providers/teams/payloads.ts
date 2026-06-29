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

// Entidade genérica de activity — usada aqui só para extrair menções (@bot) do texto
// em mensagens de canal/grupo, onde o Teams sempre prefixa o texto com `<at>NomeDoBot</at>`
export const teamsEntitySchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    mentioned: teamsChannelAccountSchema.optional(),
  })
  .passthrough();

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
    // Menções (@bot) em mensagens de canal/grupo — Teams só entrega a activity ao bot
    // quando ele é mencionado, e o texto vem com "<at>NomeDoBot</at>" embutido
    entities: z.array(teamsEntitySchema).default([]),
    channelData: z
      .object({
        // aadGroupId é o Azure AD Group ID (GUID) do team — diferente de team.id que às vezes
        // vem como thread ID (19:xxx@thread.tacv2). O Graph exige o GUID; o Bot Framework
        // Connector aceita os dois, mas Graph não. Ver docs/learnings.md (Microsoft Teams).
        team: z.object({
          id: z.string(),
          name: z.string().optional(),
          aadGroupId: z.string().optional(),
        }).optional(),
        channel: z.object({ id: z.string(), name: z.string().optional() }).optional(),
        tenant: z.object({ id: z.string() }).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type TeamsActivity = z.infer<typeof teamsActivitySchema>;

// ── Microsoft Graph change notifications ────────────────────────────────────────
// Protocolo completamente separado do Bot Framework Activity acima — usado só para
// captar mensagens de canal que o bot não "vê" via Connector (replies sem @menção).
// Ver docs/learnings.md (Microsoft Teams) para o porquê de existir um segundo protocolo.

export const graphChangeNotificationSchema = z
  .object({
    subscriptionId: z.string(),
    clientState: z.string().optional(),
    changeType: z.string(), // 'created' | 'updated' | 'deleted'
    // path que se pode dar de GET direto no Graph para obter o recurso atual —
    // ex.: "teams('T')/channels('C')/messages('M')" ou ".../messages('M')/replies('R')"
    resource: z.string(),
    tenantId: z.string().optional(),
  })
  .passthrough();

export const graphNotificationBodySchema = z.object({
  value: z.array(graphChangeNotificationSchema),
});

// Forma mínima do chatMessage retornado pelo Graph ao buscar o recurso da notificação —
// note que é uma forma bem diferente da activity do Bot Framework (body HTML, from.user
// com AAD Object ID em vez do "29:..." que vem das activities — ver docs/learnings.md)

// Reações a uma mensagem de canal — presentes no campo `reactions[]` do chatMessage
// quando buscado via GET após uma change notification `updated`
export const graphMessageReactionSchema = z
  .object({
    reactionType: z.string(),
    createdDateTime: z.string().optional(),
    user: z
      .object({
        user: z.object({ id: z.string(), displayName: z.string().optional() }).optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .passthrough();

export const graphChatMessageSchema = z
  .object({
    id: z.string(),
    createdDateTime: z.string().optional(),
    from: z
      .object({
        // user é null quando a mensagem é do bot; application é null quando é de um usuário.
        // O Graph retorna null explícito (não campo ausente), então precisamos de .nullable()
        // além de .optional() em ambos — de outro modo o parse falha para mensagens de usuário.
        user: z.object({ id: z.string(), displayName: z.string().optional() }).optional().nullable(),
        application: z.object({ id: z.string() }).optional().nullable(),
      })
      .nullable()
      .optional(),
    body: z.object({ contentType: z.string().optional(), content: z.string() }),
    reactions: z.array(graphMessageReactionSchema).optional(),
  })
  .passthrough();

export type GraphChangeNotification = z.infer<typeof graphChangeNotificationSchema>;
export type GraphChatMessage = z.infer<typeof graphChatMessageSchema>;
export type GraphMessageReaction = z.infer<typeof graphMessageReactionSchema>;
