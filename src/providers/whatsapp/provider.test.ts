import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppProvider } from './provider.js';

const config = {
  accessToken: 'test-access-token',
  phoneNumberId: '106540352242922',
  appSecret: 'test-app-secret',
  verifyToken: 'verify-me',
  apiVersion: 'v23.0',
};

const provider = new WhatsAppProvider(config);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`;
}

describe('handleVerification', () => {
  it('responde o challenge quando o verify token confere', () => {
    const challenge = provider.handleVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-me',
      'hub.challenge': '1158201444',
    });
    expect(challenge).toBe('1158201444');
  });

  it('recusa verify token errado', () => {
    const challenge = provider.handleVerification({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'errado',
      'hub.challenge': '1158201444',
    });
    expect(challenge).toBeNull();
  });
});

describe('verifySignature', () => {
  it('aceita assinatura HMAC-SHA256 válida sobre o raw body', () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(provider.verifySignature(body, { 'x-hub-signature-256': sign(body) })).toBe(true);
  });

  it('rejeita assinatura inválida e header ausente', () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(provider.verifySignature(body, { 'x-hub-signature-256': sign('outro corpo') })).toBe(false);
    expect(provider.verifySignature(body, {})).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('traduz mensagem de texto recebida para o tipo agnóstico', () => {
    const events = provider.parseWebhook(loadFixture('inbound-text.json'));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe('message');
    if (event.kind !== 'message') return;
    expect(event.message.from).toBe('5511999998888');
    expect(event.message.providerMessageId).toMatch(/^wamid\./);
    expect(event.message.content).toEqual({ kind: 'text', text: 'Olá, mundo!' });
    expect(event.message.timestamp.getTime()).toBe(1749600000 * 1000);
  });

  it('traduz evento de status (delivered) com o wamid de correlação', () => {
    const events = provider.parseWebhook(loadFixture('status-delivered.json'));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe('status');
    if (event.kind !== 'status') return;
    expect(event.status.status).toBe('delivered');
    expect(event.status.recipient).toBe('5511999998888');
    expect(event.status.providerMessageId).toMatch(/^wamid\./);
  });

  it('traduz reação apontando o wamid da mensagem reagida', () => {
    const events = provider.parseWebhook(loadFixture('inbound-reaction.json'));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    if (event.kind !== 'message') throw new Error('esperava message');
    expect(event.message.content).toEqual({
      kind: 'reaction',
      targetMessageId: 'wamid.HBgNNTUxMTk5OTk5ODg4OBUCABEYEjQ2N0ZBQTNGQkU2OEQxRkQzNQA=',
      emoji: '👍',
    });
  });

  it('traduz button_reply como choice e captura replyTo do context', () => {
    const events = provider.parseWebhook(loadFixture('inbound-button-reply.json'));
    const event = events[0]!;
    if (event.kind !== 'message') throw new Error('esperava message');
    expect(event.message.content).toEqual({
      kind: 'choice',
      choiceId: 'confirm-order',
      label: 'Confirmar pedido',
      source: 'button',
    });
    expect(event.message.replyTo).toBe(
      'wamid.HBgNNTUxMTk5OTk5ODg4OBUCABEYEjQ2N0ZBQTNGQkU2OEQxRkQzNQA=',
    );
  });

  it('traduz localização e mensagem apagada (unsupported)', () => {
    const make = (message: Record<string, unknown>) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            { field: 'messages', value: { messages: [{ from: '5511', timestamp: '1749600000', ...message }] } },
          ],
        },
      ],
    });

    const locationEvents = provider.parseWebhook(
      make({
        id: 'wamid.LOC1',
        type: 'location',
        location: { latitude: -23.55, longitude: -46.63, name: 'São Paulo' },
      }),
    );
    const locationEvent = locationEvents[0]!;
    if (locationEvent.kind !== 'message') throw new Error('esperava message');
    expect(locationEvent.message.content).toEqual({
      kind: 'location',
      latitude: -23.55,
      longitude: -46.63,
      name: 'São Paulo',
    });

    const deletedEvents = provider.parseWebhook(
      make({
        id: 'wamid.DEL1',
        type: 'unsupported',
        errors: [{ code: 131051, title: 'Message type unknown' }],
      }),
    );
    const deletedEvent = deletedEvents[0]!;
    if (deletedEvent.kind !== 'message') throw new Error('esperava message');
    expect(deletedEvent.message.content).toEqual({ kind: 'unsupported', nativeType: 'unsupported' });
  });

  it('payload irreconhecível vira evento unknown (sem perder o raw)', () => {
    const events = provider.parseWebhook({ foo: 'bar' });
    expect(events).toEqual([{ kind: 'unknown', raw: { foo: 'bar' } }]);
  });
});

describe('send', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('envia texto via Graph API e extrai o providerMessageId', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: '5511999998888' }],
            messages: [{ id: 'wamid.SAIDA123' }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.send({
      to: '5511999998888',
      content: { kind: 'text', text: 'oi' },
    });

    expect(result.providerMessageId).toBe('wamid.SAIDA123');

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/106540352242922/messages');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-access-token',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999998888',
      type: 'text',
      text: { body: 'oi' },
    });
  });

  it('envia reação referenciando o wamid da mensagem alvo', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.REACT-OUT' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await provider.send({
      to: '5511999998888',
      content: { kind: 'reaction', targetMessageId: 'wamid.ALVO', emoji: '👍' },
    });

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      type: 'reaction',
      reaction: { message_id: 'wamid.ALVO', emoji: '👍' },
    });
  });

  it('replyTo vira context.message_id (resposta citando)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.REPLY-OUT' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await provider.send({
      to: '5511999998888',
      content: { kind: 'text', text: 'respondendo' },
      replyTo: 'wamid.CITADA',
    });

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      type: 'text',
      context: { message_id: 'wamid.CITADA' },
    });
  });

  it('markAsRead envia confirmação de leitura', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await provider.markAsRead('wamid.LIDA');

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.LIDA',
    });
  });

  it('normaliza celular brasileiro sem o nono dígito (wa_id legado)', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.BR' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // wa_id chega sem o 9; envio precisa ir com o 9 (erro #131030 sem isso)
    await provider.send({ to: '554896175805', content: { kind: 'text', text: 'oi' } });
    // número com 9, "+" e formatação devem passar intactos (apenas dígitos)
    await provider.send({ to: '+55 48 99617-5805', content: { kind: 'text', text: 'oi' } });

    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).to,
    );
    expect(bodies).toEqual(['5548996175805', '5548996175805']);
  });

  it('propaga erro da API com status e corpo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 401 })),
    );

    await expect(
      provider.send({ to: '5511999998888', content: { kind: 'text', text: 'oi' } }),
    ).rejects.toThrow(/401/);
  });
});
