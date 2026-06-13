import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { z } from 'zod';
import type { ChannelProvider } from '../core/provider.js';
import type { MessageStore } from '../core/store.js';

export interface AppOptions {
  providers: Record<string, ChannelProvider>;
  store: MessageStore;
  logger?: boolean;
}

const sendBodySchema = z.object({
  to: z.string().min(1),
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string().min(1) }),
    z.object({
      kind: z.literal('template'),
      name: z.string().min(1),
      language: z.string().min(1),
      variables: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal('media'),
      mediaType: z.enum(['image', 'audio', 'video', 'document', 'sticker']),
      mediaId: z.string().optional(),
      url: z.string().url().optional(),
      caption: z.string().optional(),
    }),
    z.object({
      kind: z.literal('reaction'),
      targetMessageId: z.string().min(1),
      emoji: z.string().optional(),
    }),
  ]),
  replyTo: z.string().min(1).optional(),
});

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { providers, store } = options;
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(rawBody, { field: 'rawBody', global: false, runFirst: true });

  const getProvider = (channel: string): ChannelProvider | undefined => providers[channel];

  // Inicia conexões persistentes dos providers que precisam (ex.: Discord Gateway)
  for (const provider of Object.values(providers)) {
    if (provider.start) {
      await provider.start({
        store,
        log: {
          info: (msg, data) => app.log.info(data ?? {}, msg),
          warn: (msg, data) => app.log.warn(data ?? {}, msg),
          error: (msg, data) => app.log.error(data ?? {}, msg),
        },
      });
    }
  }

  app.addHook('onClose', async () => {
    for (const provider of Object.values(providers)) {
      await provider.stop?.();
    }
  });

  // Dashboard de inspeção
  app.get('/', async (_request, reply) => {
    const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Handshake de verificação do webhook (Meta envia GET com hub.challenge)
  app.get<{ Params: { channel: string } }>('/webhooks/:channel', async (request, reply) => {
    const provider = getProvider(request.params.channel);
    if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });

    const challenge = provider.handleVerification(request.query as Record<string, unknown>);
    if (challenge === null) {
      request.log.warn('verificação de webhook recusada');
      return reply.code(403).send('Forbidden');
    }
    return reply.type('text/plain').send(challenge);
  });

  app.post<{ Params: { channel: string } }>(
    '/webhooks/:channel',
    { config: { rawBody: true } },
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });

      const raw = request.rawBody ?? '';
      const signatureValid = provider.verifySignature(raw, request.headers);

      const webhookRequestId = store.saveWebhookRequest({
        channel: provider.channel,
        headers: request.headers,
        body: typeof raw === 'string' ? raw : raw.toString('utf8'),
        signatureValid,
      });

      if (!signatureValid) {
        request.log.warn({ webhookRequestId }, 'assinatura inválida — evento não processado');
        return reply.code(401).send();
      }

      // Resposta síncrona para verificações POST-based (ex.: Slack URL verification)
      const challenge = provider.handleWebhookChallenge?.(request.body);
      if (challenge !== null && challenge !== undefined) {
        return reply.type('text/plain').send(challenge);
      }

      await reply.code(200).send();

      try {
        for (const event of provider.parseWebhook(request.body)) {
          switch (event.kind) {
            case 'message':
              store.saveInbound({ channel: provider.channel, message: event.message, webhookRequestId });
              break;
            case 'status':
              store.saveStatusEvent({ channel: provider.channel, status: event.status, webhookRequestId });
              break;
            case 'unknown':
              request.log.info({ webhookRequestId, raw: event.raw }, 'evento não mapeado pelo provider');
              break;
          }
        }
      } catch (error) {
        request.log.error({ err: error, webhookRequestId }, 'falha ao processar evento de webhook');
      }
    },
  );

  // Envio de mensagem
  app.post<{ Params: { channel: string } }>('/api/:channel/send', async (request, reply) => {
    const provider = getProvider(request.params.channel);
    if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });

    const parsed = sendBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'payload inválido', issues: parsed.error.issues });
    }

    const result = await provider.send(parsed.data);
    store.saveOutbound({ channel: provider.channel, message: parsed.data, result });

    return reply.code(201).send({ providerMessageId: result.providerMessageId, raw: result.raw });
  });

  // Confirma leitura de mensagem recebida
  app.post<{ Params: { channel: string; providerMessageId: string } }>(
    '/api/:channel/messages/:providerMessageId/read',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });

      await provider.markAsRead(request.params.providerMessageId);
      return { ok: true };
    },
  );

  // Edição de mensagem enviada (ex.: Discord, Telegram)
  app.patch<{ Params: { channel: string; providerMessageId: string } }>(
    '/api/:channel/messages/:providerMessageId',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });
      if (!provider.editMessage) {
        return reply.code(405).send({ error: `canal ${request.params.channel} não suporta edição` });
      }

      const parsed = z.object({ text: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'payload inválido', issues: parsed.error.issues });
      }

      await provider.editMessage(request.params.providerMessageId, parsed.data.text);
      return { ok: true };
    },
  );

  // Exclusão de mensagem enviada (ex.: Discord, Telegram)
  app.delete<{ Params: { channel: string; providerMessageId: string } }>(
    '/api/:channel/messages/:providerMessageId',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });
      if (!provider.deleteMessage) {
        return reply.code(405).send({ error: `canal ${request.params.channel} não suporta exclusão` });
      }

      await provider.deleteMessage(request.params.providerMessageId);
      return reply.code(204).send();
    },
  );

  // Correção de mensagem enviada:
  // - canais com edição nativa (Slack, Discord): edita a mensagem diretamente
  // - canais sem edição (WhatsApp): padrão reação ⚠️ + reply com texto corrigido
  app.post<{ Params: { channel: string; providerMessageId: string } }>(
    '/api/:channel/messages/:providerMessageId/correct',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });

      const parsed = z.object({ text: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'payload inválido', issues: parsed.error.issues });
      }

      const messageId = request.params.providerMessageId;
      const timeline = store.getMessageTimeline(messageId);
      if (!timeline) return reply.code(404).send({ error: 'mensagem enviada não encontrada' });

      if (provider.editMessage) {
        await provider.editMessage(messageId, parsed.data.text);
        return reply.code(200).send({ edited: true });
      }

      // Fallback: padrão WhatsApp (canal não suporta edição)
      const to = timeline.outbound.recipient;

      const reactionMessage = {
        to,
        content: { kind: 'reaction', targetMessageId: messageId, emoji: '⚠️' },
      } as const;
      const reactionResult = await provider.send(reactionMessage);
      store.saveOutbound({ channel: provider.channel, message: reactionMessage, result: reactionResult });

      const correctionMessage = {
        to,
        content: { kind: 'text', text: parsed.data.text },
        replyTo: messageId,
      } as const;
      const correctionResult = await provider.send(correctionMessage);
      store.saveOutbound({ channel: provider.channel, message: correctionMessage, result: correctionResult });

      return reply.code(201).send({
        reactionMessageId: reactionResult.providerMessageId,
        correctionMessageId: correctionResult.providerMessageId,
      });
    },
  );

  // Lista destinos disponíveis para envio no canal (ex.: servidores/canais do Discord)
  app.get<{ Params: { channel: string } }>(
    '/api/:channel/destinations',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });
      if (!provider.listDestinations) {
        return reply.code(405).send({ error: 'canal não suporta listagem de destinos' });
      }
      return provider.listDestinations();
    },
  );

  // Abre (ou recupera) canal de DM com um usuário — Discord e Slack
  app.post<{ Params: { channel: string } }>(
    '/api/:channel/dm',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });
      if (!provider.openDM) {
        return reply.code(405).send({ error: 'canal não suporta abertura de DM via API' });
      }

      const parsed = z.object({ userId: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'payload inválido', issues: parsed.error.issues });
      }

      const channelId = await provider.openDM(parsed.data.userId);
      return { channelId };
    },
  );

  // Correlação: mensagem enviada + status recebidos + interações
  app.get<{ Params: { providerMessageId: string } }>(
    '/api/messages/:providerMessageId/timeline',
    async (request, reply) => {
      const timeline = store.getMessageTimeline(request.params.providerMessageId);
      if (!timeline) return reply.code(404).send({ error: 'mensagem não encontrada' });
      return timeline;
    },
  );

  app.get('/api/messages/outbound', async (request) => {
    const { before, limit } = request.query as { before?: string; limit?: string };
    return store.listOutbound({
      ...(limit ? { limit: Math.min(parseInt(limit, 10), 200) } : {}),
      ...(before ? { before: parseInt(before, 10) } : {}),
    });
  });
  app.get('/api/messages/inbound', async (request) => {
    const { before, limit } = request.query as { before?: string; limit?: string };
    return store.listInbound({
      ...(limit ? { limit: Math.min(parseInt(limit, 10), 200) } : {}),
      ...(before ? { before: parseInt(before, 10) } : {}),
    });
  });
  app.get('/api/webhook-requests', async (request) => {
    const { before, limit } = request.query as { before?: string; limit?: string };
    return store.listWebhookRequests({
      ...(limit ? { limit: Math.min(parseInt(limit, 10), 200) } : {}),
      ...(before ? { before: parseInt(before, 10) } : {}),
    });
  });

  return app;
}
