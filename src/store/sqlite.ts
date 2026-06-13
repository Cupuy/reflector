import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  InboundRecord,
  MessageStore,
  MessageTimeline,
  OutboundRecord,
  StatusEventRecord,
  WebhookRequestRecord,
} from '../core/store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  received_at TEXT NOT NULL,
  headers TEXT NOT NULL,
  body TEXT NOT NULL,
  signature_valid INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  provider_message_id TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  content TEXT NOT NULL,
  api_response TEXT NOT NULL,
  reply_to TEXT,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  provider_message_id TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  raw TEXT NOT NULL,
  reply_to TEXT,
  webhook_request_id INTEGER NOT NULL REFERENCES webhook_requests(id),
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  webhook_request_id INTEGER NOT NULL REFERENCES webhook_requests(id),
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_events_pmid ON status_events(provider_message_id);
`;

export class SqliteStore implements MessageStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** migrações aditivas para bancos criados antes de colunas novas */
  private migrate(): void {
    for (const table of ['inbound_messages', 'outbound_messages']) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'reply_to')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN reply_to TEXT`);
      }
    }
  }

  saveWebhookRequest(input: {
    channel: string;
    headers: unknown;
    body: string;
    signatureValid: boolean;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO webhook_requests (channel, received_at, headers, body, signature_valid)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.channel,
        new Date().toISOString(),
        JSON.stringify(input.headers),
        input.body,
        input.signatureValid ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  saveOutbound(input: Parameters<MessageStore['saveOutbound']>[0]): void {
    this.db
      .prepare(
        `INSERT INTO outbound_messages (channel, provider_message_id, recipient, content, api_response, reply_to, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.channel,
        input.result.providerMessageId,
        input.message.to,
        JSON.stringify(input.message.content),
        JSON.stringify(input.result.raw),
        input.message.replyTo ?? null,
        new Date().toISOString(),
      );
  }

  saveInbound(input: Parameters<MessageStore['saveInbound']>[0]): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO inbound_messages
           (channel, provider_message_id, sender, content, raw, reply_to, webhook_request_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.channel,
        input.message.providerMessageId,
        input.message.from,
        JSON.stringify(input.message.content),
        JSON.stringify(input.message.raw),
        input.message.replyTo ?? null,
        input.webhookRequestId,
        input.message.timestamp.toISOString(),
      );
  }

  saveStatusEvent(input: Parameters<MessageStore['saveStatusEvent']>[0]): void {
    this.db
      .prepare(
        `INSERT INTO status_events (channel, provider_message_id, status, error, webhook_request_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.channel,
        input.status.providerMessageId,
        input.status.status,
        input.status.error ? JSON.stringify(input.status.error) : null,
        input.webhookRequestId,
        input.status.timestamp.toISOString(),
      );
  }

  getMessageTimeline(providerMessageId: string): MessageTimeline | null {
    const row = this.db
      .prepare(`SELECT * FROM outbound_messages WHERE provider_message_id = ?`)
      .get(providerMessageId) as OutboundRow | undefined;
    if (!row) return null;

    const statusRows = this.db
      .prepare(`SELECT * FROM status_events WHERE provider_message_id = ? ORDER BY id`)
      .all(providerMessageId) as StatusRow[];

    const reactionRows = this.db
      .prepare(
        `SELECT * FROM inbound_messages
         WHERE json_extract(content, '$.kind') = 'reaction'
           AND json_extract(content, '$.targetMessageId') = ?
         ORDER BY id`,
      )
      .all(providerMessageId) as InboundRow[];

    const replyRows = this.db
      .prepare(`SELECT * FROM inbound_messages WHERE reply_to = ? ORDER BY id`)
      .all(providerMessageId) as InboundRow[];

    const outboundReactionRows = this.db
      .prepare(
        `SELECT * FROM outbound_messages
         WHERE json_extract(content, '$.kind') = 'reaction'
           AND json_extract(content, '$.targetMessageId') = ?
         ORDER BY id`,
      )
      .all(providerMessageId) as OutboundRow[];

    const outboundReplyRows = this.db
      .prepare(`SELECT * FROM outbound_messages WHERE reply_to = ? ORDER BY id`)
      .all(providerMessageId) as OutboundRow[];

    return {
      outbound: toOutboundRecord(row),
      statuses: statusRows.map(toStatusRecord),
      reactions: reactionRows.map(toInboundRecord),
      replies: replyRows.map(toInboundRecord),
      outboundReactions: outboundReactionRows.map(toOutboundRecord),
      outboundReplies: outboundReplyRows.map(toOutboundRecord),
    };
  }

  listOutbound({ limit = 50, before }: { limit?: number; before?: number } = {}): OutboundRecord[] {
    const rows = (before !== undefined
      ? this.db.prepare(`SELECT * FROM outbound_messages WHERE id < ? ORDER BY id DESC LIMIT ?`).all(before, limit)
      : this.db.prepare(`SELECT * FROM outbound_messages ORDER BY id DESC LIMIT ?`).all(limit)
    ) as OutboundRow[];
    return rows.map(toOutboundRecord);
  }

  listInbound({ limit = 50, before }: { limit?: number; before?: number } = {}): InboundRecord[] {
    const rows = (before !== undefined
      ? this.db.prepare(`SELECT * FROM inbound_messages WHERE id < ? ORDER BY id DESC LIMIT ?`).all(before, limit)
      : this.db.prepare(`SELECT * FROM inbound_messages ORDER BY id DESC LIMIT ?`).all(limit)
    ) as InboundRow[];
    return rows.map(toInboundRecord);
  }

  listWebhookRequests({ limit = 50, before }: { limit?: number; before?: number } = {}): WebhookRequestRecord[] {
    const rows = (before !== undefined
      ? this.db.prepare(`SELECT * FROM webhook_requests WHERE id < ? ORDER BY id DESC LIMIT ?`).all(before, limit)
      : this.db.prepare(`SELECT * FROM webhook_requests ORDER BY id DESC LIMIT ?`).all(limit)
    ) as WebhookRequestRow[];
    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      receivedAt: row.received_at,
      headers: JSON.parse(row.headers),
      body: row.body,
      signatureValid: row.signature_valid === 1,
    }));
  }

  close(): void {
    this.db.close();
  }
}

interface WebhookRequestRow {
  id: number;
  channel: string;
  received_at: string;
  headers: string;
  body: string;
  signature_valid: number;
}

interface OutboundRow {
  id: number;
  channel: string;
  provider_message_id: string;
  recipient: string;
  content: string;
  api_response: string;
  reply_to: string | null;
  sent_at: string;
}

interface InboundRow {
  id: number;
  channel: string;
  provider_message_id: string;
  sender: string;
  content: string;
  raw: string;
  reply_to: string | null;
  webhook_request_id: number;
  received_at: string;
}

function toInboundRecord(row: InboundRow): InboundRecord {
  return {
    id: row.id,
    channel: row.channel,
    providerMessageId: row.provider_message_id,
    sender: row.sender,
    content: JSON.parse(row.content),
    raw: JSON.parse(row.raw),
    replyTo: row.reply_to,
    webhookRequestId: row.webhook_request_id,
    receivedAt: row.received_at,
  };
}

interface StatusRow {
  id: number;
  channel: string;
  provider_message_id: string;
  status: string;
  error: string | null;
  webhook_request_id: number;
  occurred_at: string;
}

function toOutboundRecord(row: OutboundRow): OutboundRecord {
  return {
    id: row.id,
    channel: row.channel,
    providerMessageId: row.provider_message_id,
    recipient: row.recipient,
    content: JSON.parse(row.content),
    apiResponse: JSON.parse(row.api_response),
    replyTo: row.reply_to,
    sentAt: row.sent_at,
  };
}

function toStatusRecord(row: StatusRow): StatusEventRecord {
  return {
    id: row.id,
    channel: row.channel,
    providerMessageId: row.provider_message_id,
    status: row.status,
    error: row.error ? JSON.parse(row.error) : null,
    webhookRequestId: row.webhook_request_id,
    occurredAt: row.occurred_at,
  };
}
