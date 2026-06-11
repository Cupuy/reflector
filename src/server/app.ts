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

  // Dashboard de inspeção: timeline de envios, payloads e requests brutas
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
      request.log.warn('verificação de webhook recusada: verify token não confere');
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

      // Persiste TODA request recebida, válida ou não — é a matéria-prima do laboratório
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

      // 200 imediato; a Meta reenvia eventos sem ack e o processamento não deve atrasar isso
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

  app.post<{ Params: { channel: string; providerMessageId: string } }>(
    '/api/:channel/messages/:providerMessageId/read',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });

      await provider.markAsRead(request.params.providerMessageId);
      return { ok: true };
    },
  );

  // Padrão de correção pós-envio: a Cloud API não permite editar mensagem enviada,
  // então sinalizamos a original com ⚠️ e enviamos um reply citando-a com o texto corrigido
  app.post<{ Params: { channel: string; providerMessageId: string } }>(
    '/api/:channel/messages/:providerMessageId/correct',
    async (request, reply) => {
      const provider = getProvider(request.params.channel);
      if (!provider) return reply.code(404).send({ error: 'canal desconhecido' });

      const parsed = z.object({ text: z.string().min(1) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'payload inválido', issues: parsed.error.issues });
      }

      const wamid = request.params.providerMessageId;
      const timeline = store.getMessageTimeline(wamid);
      if (!timeline) return reply.code(404).send({ error: 'mensagem enviada não encontrada' });

      const to = timeline.outbound.recipient;

      const reactionMessage = {
        to,
        content: { kind: 'reaction', targetMessageId: wamid, emoji: '⚠️' },
      } as const;
      const reactionResult = await provider.send(reactionMessage);
      store.saveOutbound({ channel: provider.channel, message: reactionMessage, result: reactionResult });

      const correctionMessage = {
        to,
        content: { kind: 'text', text: parsed.data.text },
        replyTo: wamid,
      } as const;
      const correctionResult = await provider.send(correctionMessage);
      store.saveOutbound({ channel: provider.channel, message: correctionMessage, result: correctionResult });

      return reply.code(201).send({
        reactionMessageId: reactionResult.providerMessageId,
        correctionMessageId: correctionResult.providerMessageId,
      });
    },
  );

  // Correlação: mensagem enviada + status recebidos via webhook (cada um aponta o webhook_request de origem)
  app.get<{ Params: { providerMessageId: string } }>(
    '/api/messages/:providerMessageId/timeline',
    async (request, reply) => {
      const timeline = store.getMessageTimeline(request.params.providerMessageId);
      if (!timeline) return reply.code(404).send({ error: 'mensagem não encontrada' });
      return timeline;
    },
  );

  app.get('/api/messages/outbound', async () => store.listOutbound());
  app.get('/api/messages/inbound', async () => store.listInbound());
  app.get('/api/webhook-requests', async () => store.listWebhookRequests());

  return app;
}
