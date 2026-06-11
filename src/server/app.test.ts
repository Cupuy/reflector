import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppProvider } from '../providers/whatsapp/provider.js';
import { SqliteStore } from '../store/sqlite.js';
import { buildApp } from './app.js';

const APP_SECRET = 'test-app-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

describe('fluxo completo: envio via API ↔ webhook de status', () => {
  let app: FastifyInstance;
  let store: SqliteStore;

  beforeEach(async () => {
    store = new SqliteStore(':memory:');
    const whatsapp = new WhatsAppProvider({
      accessToken: 'test-token',
      phoneNumberId: '106540352242922',
      appSecret: APP_SECRET,
      verifyToken: 'verify-me',
      apiVersion: 'v23.0',
    });
    app = await buildApp({ providers: { whatsapp }, store, logger: false });
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it('serve o dashboard de inspeção em /', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('reflector');
  });

  it('responde o handshake GET de verificação', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('42');
  });

  it('rejeita webhook com assinatura inválida, mas persiste a request', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: body,
    });

    expect(response.statusCode).toBe(401);
    const requests = store.listWebhookRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signatureValid).toBe(false);
  });

  it('marca mensagem recebida como lida via endpoint', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: `/api/whatsapp/messages/${encodeURIComponent('wamid.LIDA==')}/read`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      status: 'read',
      message_id: 'wamid.LIDA==',
    });
  });

  it('envio com replyTo persiste a correlação com a mensagem citada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT-REPLY' }] }), { status: 200 }),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/send',
      payload: {
        to: '5511999998888',
        content: { kind: 'text', text: 'respondendo' },
        replyTo: 'wamid.RECEBIDA',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(store.listOutbound()[0]!.replyTo).toBe('wamid.RECEBIDA');
  });

  it('corrige mensagem enviada: ⚠️ na original + reply com o texto corrigido', async () => {
    let counter = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: `wamid.C${++counter}` }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // 404 para wamid desconhecido
    const notFound = await app.inject({
      method: 'POST',
      url: `/api/whatsapp/messages/${encodeURIComponent('wamid.NOPE')}/correct`,
      payload: { text: 'x' },
    });
    expect(notFound.statusCode).toBe(404);

    // envio original
    await app.inject({
      method: 'POST',
      url: '/api/whatsapp/send',
      payload: { to: '5548996175805', content: { kind: 'text', text: 'preço: R$ 100' } },
    });

    // correção
    const response = await app.inject({
      method: 'POST',
      url: `/api/whatsapp/messages/${encodeURIComponent('wamid.C1')}/correct`,
      payload: { text: 'Correção: o preço é R$ 110' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      reactionMessageId: 'wamid.C2',
      correctionMessageId: 'wamid.C3',
    });

    // payloads enviados à Graph API: reação ⚠️ e reply citando a original
    const bodies = fetchMock.mock.calls
      .slice(1)
      .map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0]).toMatchObject({
      type: 'reaction',
      reaction: { message_id: 'wamid.C1', emoji: '⚠️' },
    });
    expect(bodies[1]).toMatchObject({
      type: 'text',
      text: { body: 'Correção: o preço é R$ 110' },
      context: { message_id: 'wamid.C1' },
    });

    // timeline da original passa a mostrar a correção
    const timeline = store.getMessageTimeline('wamid.C1')!;
    expect(timeline.outboundReactions).toHaveLength(1);
    expect(timeline.outboundReplies).toHaveLength(1);
    expect(timeline.outboundReplies[0]!.providerMessageId).toBe('wamid.C3');
  });

  it('correlaciona envio → status delivered → timeline', async () => {
    const wamid = 'wamid.HBgNNTUxMTk5OTk5ODg4OBUCABEYEjQ2N0ZBQTNGQkU2OEQxRkQzNQA=';

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200 }),
      ),
    );

    // 1. aplicação envia mensagem via API
    const sendResponse = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/send',
      payload: { to: '5511999998888', content: { kind: 'text', text: 'oi' } },
    });
    expect(sendResponse.statusCode).toBe(201);
    expect(sendResponse.json().providerMessageId).toBe(wamid);

    // 2. Meta entrega webhook de status referenciando o mesmo wamid
    const webhookBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                statuses: [
                  {
                    id: wamid,
                    status: 'delivered',
                    timestamp: '1749600100',
                    recipient_id: '5511999998888',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const webhookResponse = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(webhookBody) },
      payload: webhookBody,
    });
    expect(webhookResponse.statusCode).toBe(200);

    // 3. timeline correlaciona o envio com o status recebido
    const timelineResponse = await app.inject({
      method: 'GET',
      url: `/api/messages/${encodeURIComponent(wamid)}/timeline`,
    });
    expect(timelineResponse.statusCode).toBe(200);

    const timeline = timelineResponse.json();
    expect(timeline.outbound.providerMessageId).toBe(wamid);
    expect(timeline.statuses).toHaveLength(1);
    expect(timeline.statuses[0].status).toBe('delivered');

    // e o status aponta para a request bruta de webhook persistida
    const webhookRequests = store.listWebhookRequests();
    expect(webhookRequests).toHaveLength(1);
    expect(timeline.statuses[0].webhookRequestId).toBe(webhookRequests[0]!.id);
  });
});
