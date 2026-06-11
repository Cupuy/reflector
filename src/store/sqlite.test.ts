import { describe, expect, it } from 'vitest';
import { SqliteStore } from './sqlite.js';

function newStore(): SqliteStore {
  return new SqliteStore(':memory:');
}

describe('SqliteStore', () => {
  it('correlaciona mensagem enviada com status recebidos via webhook', () => {
    const store = newStore();

    store.saveOutbound({
      channel: 'whatsapp',
      message: { to: '5511999998888', content: { kind: 'text', text: 'oi' } },
      result: { providerMessageId: 'wamid.X', raw: { messages: [{ id: 'wamid.X' }] } },
    });

    const webhookRequestId = store.saveWebhookRequest({
      channel: 'whatsapp',
      headers: { 'x-hub-signature-256': 'sha256=abc' },
      body: '{"entry":[]}',
      signatureValid: true,
    });

    store.saveStatusEvent({
      channel: 'whatsapp',
      status: {
        providerMessageId: 'wamid.X',
        recipient: '5511999998888',
        status: 'delivered',
        timestamp: new Date('2026-06-10T12:00:00Z'),
        raw: {},
      },
      webhookRequestId,
    });

    const timeline = store.getMessageTimeline('wamid.X');
    expect(timeline).not.toBeNull();
    expect(timeline!.outbound.recipient).toBe('5511999998888');
    expect(timeline!.statuses).toHaveLength(1);
    expect(timeline!.statuses[0]!.status).toBe('delivered');
    // cada status aponta a request de webhook que o originou
    expect(timeline!.statuses[0]!.webhookRequestId).toBe(webhookRequestId);
  });

  it('deduplica mensagens recebidas reentregues (mesmo providerMessageId)', () => {
    const store = newStore();
    const webhookRequestId = store.saveWebhookRequest({
      channel: 'whatsapp',
      headers: {},
      body: '{}',
      signatureValid: true,
    });

    const message = {
      providerMessageId: 'wamid.IN',
      from: '5511999998888',
      timestamp: new Date(),
      content: { kind: 'text' as const, text: 'oi' },
      raw: {},
    };

    store.saveInbound({ channel: 'whatsapp', message, webhookRequestId });
    store.saveInbound({ channel: 'whatsapp', message, webhookRequestId });

    expect(store.listInbound()).toHaveLength(1);
  });

  it('timeline inclui reações e replies que apontam para a mensagem enviada', () => {
    const store = newStore();
    const wamid = 'wamid.OUT';

    store.saveOutbound({
      channel: 'whatsapp',
      message: { to: '5511999998888', content: { kind: 'text', text: 'confirma?' } },
      result: { providerMessageId: wamid, raw: {} },
    });

    const webhookRequestId = store.saveWebhookRequest({
      channel: 'whatsapp',
      headers: {},
      body: '{}',
      signatureValid: true,
    });

    store.saveInbound({
      channel: 'whatsapp',
      message: {
        providerMessageId: 'wamid.REACT',
        from: '5511999998888',
        timestamp: new Date(),
        content: { kind: 'reaction', targetMessageId: wamid, emoji: '👍' },
        raw: {},
      },
      webhookRequestId,
    });

    store.saveInbound({
      channel: 'whatsapp',
      message: {
        providerMessageId: 'wamid.REPLY',
        from: '5511999998888',
        timestamp: new Date(),
        content: { kind: 'choice', choiceId: 'yes', label: 'Sim', source: 'button' },
        replyTo: wamid,
        raw: {},
      },
      webhookRequestId,
    });

    const timeline = store.getMessageTimeline(wamid)!;
    expect(timeline.reactions).toHaveLength(1);
    expect(timeline.reactions[0]!.providerMessageId).toBe('wamid.REACT');
    expect(timeline.replies).toHaveLength(1);
    expect(timeline.replies[0]!.replyTo).toBe(wamid);
  });

  it('retorna null para timeline de mensagem desconhecida', () => {
    expect(newStore().getMessageTimeline('wamid.NOPE')).toBeNull();
  });

  it('lista webhook requests preservando corpo bruto e validade da assinatura', () => {
    const store = newStore();
    store.saveWebhookRequest({
      channel: 'whatsapp',
      headers: { 'user-agent': 'facebookexternalua' },
      body: '{"object":"whatsapp_business_account"}',
      signatureValid: false,
    });

    const requests = store.listWebhookRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toBe('{"object":"whatsapp_business_account"}');
    expect(requests[0]!.signatureValid).toBe(false);
  });
});
