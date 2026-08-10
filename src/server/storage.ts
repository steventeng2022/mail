import PostalMime, { type Address, type Attachment, type Email } from "postal-mime";
import type { MailAttachment, MailCounts, MailDetail, MailFolder, MailSummary } from "../shared/types";

type MessageRow = {
  id: string;
  direction: "inbound" | "outbound";
  folder: "inbox" | "sent" | "trash";
  mailbox: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  from_name: string;
  from_address: string;
  reply_to_address: string | null;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  subject: string;
  preview: string;
  text_body: string;
  raw_r2_key: string | null;
  has_attachments: number;
  is_read: number;
  is_starred: number;
  sent_at: number;
};

type AttachmentRow = {
  id: string;
  message_id: string;
  r2_key: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
};

const MAX_STORED_BODY = 750_000;
const MAX_ATTACHMENTS = 50;

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function summary(row: MessageRow): MailSummary {
  return {
    id: row.id,
    direction: row.direction,
    folder: row.folder,
    mailbox: row.mailbox,
    fromName: row.from_name,
    fromAddress: row.from_address,
    toAddresses: parseList(row.to_addresses),
    subject: row.subject,
    preview: row.preview,
    hasAttachments: Boolean(row.has_attachments),
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    sentAt: row.sent_at,
  };
}

function attachment(row: AttachmentRow): MailAttachment {
  return { id: row.id, filename: row.filename, mimeType: row.mime_type, size: row.size };
}

function flattenAddresses(addresses?: Address[]): Array<{ name: string; address: string }> {
  return (addresses ?? []).flatMap((address) => {
    if (Array.isArray(address.group)) return address.group;
    return address.address ? [{ name: address.name, address: address.address }] : [];
  });
}

function firstAddress(address?: Address) {
  if (!address) return { name: "", address: "unknown" };
  if (Array.isArray(address.group)) return address.group[0] ?? { name: address.name, address: "unknown" };
  return { name: address.name, address: address.address || "unknown" };
}

function htmlToText(html: string) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function preview(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function safeDate(value: string | undefined, fallback: number) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeFilename(value: string | null, index: number) {
  const fallback = `attachment-${index + 1}`;
  return (value || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 180) || fallback;
}

function attachmentBytes(value: Attachment) {
  if (typeof value.content === "string") return new TextEncoder().encode(value.content);
  if (value.content instanceof ArrayBuffer) return new Uint8Array(value.content);
  return new Uint8Array(value.content.buffer, value.content.byteOffset, value.content.byteLength);
}

async function hashText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fallbackDedupe(message: ForwardableEmailMessage) {
  return [message.from, message.to, message.headers.get("date"), message.headers.get("subject"), message.rawSize].join("|");
}

export async function storeIncomingMessage(message: ForwardableEmailMessage, env: Env) {
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject("Message is larger than this mailbox accepts");
    return null;
  }

  const headerMessageId = message.headers.get("message-id")?.trim() || null;
  const dedupeKey = headerMessageId?.toLowerCase() || `fallback:${await hashText(fallbackDedupe(message))}`;
  const existing = await env.DB.prepare("SELECT id FROM mail_messages WHERE dedupe_key=?")
    .bind(dedupeKey)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const rawKey = `messages/${id}/original.eml`;
  const [archiveStream, parseStream] = message.raw.tee();
  let parsed: Email;
  try {
    const [, parsedMail] = await Promise.all([
      env.MAIL_BUCKET.put(rawKey, archiveStream, { httpMetadata: { contentType: "message/rfc822" } }),
      PostalMime.parse(parseStream, { attachmentEncoding: "arraybuffer", maxHeadersSize: 256 * 1024 }),
    ]);
    parsed = parsedMail;
  } catch (error) {
    await env.MAIL_BUCKET.delete(rawKey);
    throw error;
  }

  const now = Date.now();
  const sender = firstAddress(parsed.from);
  const to = flattenAddresses(parsed.to).map((item) => item.address).filter(Boolean);
  const cc = flattenAddresses(parsed.cc).map((item) => item.address).filter(Boolean);
  const bcc = flattenAddresses(parsed.bcc).map((item) => item.address).filter(Boolean);
  const replyTo = flattenAddresses(parsed.replyTo)[0]?.address ?? null;
  const textBody = (parsed.text || htmlToText(parsed.html || "")).trim().slice(0, MAX_STORED_BODY);
  const storedAttachments: Array<AttachmentRow> = [];
  const storedKeys = [rawKey];

  for (const [index, part] of parsed.attachments.slice(0, MAX_ATTACHMENTS).entries()) {
    const attachmentId = crypto.randomUUID();
    const filename = safeFilename(part.filename, index);
    const key = `messages/${id}/attachments/${attachmentId}-${filename}`;
    const bytes = attachmentBytes(part);
    await env.MAIL_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: part.mimeType || "application/octet-stream" },
    });
    storedKeys.push(key);
    storedAttachments.push({
      id: attachmentId,
      message_id: id,
      r2_key: key,
      filename,
      mime_type: part.mimeType || "application/octet-stream",
      size: bytes.byteLength,
      content_id: part.contentId ?? null,
    });
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO mail_messages (
        id,dedupe_key,direction,folder,mailbox,message_id,in_reply_to,references_header,
        from_name,from_address,reply_to_address,to_addresses,cc_addresses,bcc_addresses,
        subject,preview,text_body,raw_r2_key,has_attachments,is_read,is_starred,sent_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        id,
        dedupeKey,
        "inbound",
        "inbox",
        message.to.toLowerCase(),
        parsed.messageId ?? headerMessageId,
        parsed.inReplyTo ?? null,
        parsed.references ?? null,
        sender.name || "",
        sender.address || message.from,
        replyTo,
        JSON.stringify(to.length ? to : [message.to]),
        JSON.stringify(cc),
        JSON.stringify(bcc),
        (parsed.subject || "(no subject)").slice(0, 500),
        preview(textBody),
        textBody,
        rawKey,
        storedAttachments.length ? 1 : 0,
        0,
        0,
        safeDate(parsed.date, now),
        now,
      ),
      ...storedAttachments.map((item) =>
        env.DB.prepare(`INSERT INTO mail_attachments
          (id,message_id,r2_key,filename,mime_type,size,content_id) VALUES(?,?,?,?,?,?,?)`)
          .bind(item.id, item.message_id, item.r2_key, item.filename, item.mime_type, item.size, item.content_id),
      ),
    ]);
  } catch (error) {
    await env.MAIL_BUCKET.delete(storedKeys);
    throw error;
  }

  return id;
}

export async function listMessages(env: Env, folder: MailFolder, query = "") {
  const filters = folder === "starred" ? ["is_starred=1", "folder!='trash'"] : ["folder=?"];
  const values: unknown[] = folder === "starred" ? [] : [folder];
  const cleanQuery = query.trim().slice(0, 120);
  if (cleanQuery) {
    filters.push("(subject LIKE ? OR from_address LIKE ? OR from_name LIKE ? OR preview LIKE ?)");
    const term = `%${cleanQuery}%`;
    values.push(term, term, term, term);
  }
  const result = await env.DB.prepare(
    `SELECT * FROM mail_messages WHERE ${filters.join(" AND ")} ORDER BY sent_at DESC LIMIT 100`,
  ).bind(...values).all<MessageRow>();
  return result.results.map(summary);
}

export async function getCounts(env: Env): Promise<MailCounts> {
  const row = await env.DB.prepare(`SELECT
    sum(CASE WHEN folder='inbox' THEN 1 ELSE 0 END) AS inbox,
    sum(CASE WHEN folder='inbox' AND is_read=0 THEN 1 ELSE 0 END) AS unread,
    sum(CASE WHEN folder='sent' THEN 1 ELSE 0 END) AS sent,
    sum(CASE WHEN is_starred=1 AND folder!='trash' THEN 1 ELSE 0 END) AS starred,
    sum(CASE WHEN folder='trash' THEN 1 ELSE 0 END) AS trash
    FROM mail_messages`).first<Record<keyof MailCounts, number | null>>();
  return {
    inbox: row?.inbox ?? 0,
    unread: row?.unread ?? 0,
    sent: row?.sent ?? 0,
    starred: row?.starred ?? 0,
    trash: row?.trash ?? 0,
  };
}

export async function getMessage(env: Env, id: string, markRead = false): Promise<MailDetail | null> {
  const row = await env.DB.prepare("SELECT * FROM mail_messages WHERE id=?").bind(id).first<MessageRow>();
  if (!row) return null;
  if (markRead && !row.is_read) {
    await env.DB.prepare("UPDATE mail_messages SET is_read=1 WHERE id=?").bind(id).run();
    row.is_read = 1;
  }
  const parts = await env.DB.prepare("SELECT * FROM mail_attachments WHERE message_id=? ORDER BY filename")
    .bind(id)
    .all<AttachmentRow>();
  return {
    ...summary(row),
    replyToAddress: row.reply_to_address,
    ccAddresses: parseList(row.cc_addresses),
    bccAddresses: parseList(row.bcc_addresses),
    textBody: row.text_body,
    attachments: parts.results.map(attachment),
  };
}

export async function getAttachmentRow(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM mail_attachments WHERE id=?").bind(id).first<AttachmentRow>();
}

export async function getRawMessageKey(env: Env, id: string) {
  return env.DB.prepare("SELECT raw_r2_key FROM mail_messages WHERE id=?")
    .bind(id)
    .first<{ raw_r2_key: string | null }>();
}

export async function updateMessage(env: Env, id: string, input: { isRead?: boolean; isStarred?: boolean; folder?: "inbox" | "sent" | "trash" }) {
  const statements: D1PreparedStatement[] = [];
  if (typeof input.isRead === "boolean") {
    statements.push(env.DB.prepare("UPDATE mail_messages SET is_read=? WHERE id=?").bind(input.isRead ? 1 : 0, id));
  }
  if (typeof input.isStarred === "boolean") {
    statements.push(env.DB.prepare("UPDATE mail_messages SET is_starred=? WHERE id=?").bind(input.isStarred ? 1 : 0, id));
  }
  if (input.folder) {
    statements.push(env.DB.prepare("UPDATE mail_messages SET folder=? WHERE id=?").bind(input.folder, id));
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function storeSentMessage(env: Env, input: {
  providerMessageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string | null;
}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO mail_messages (
    id,dedupe_key,direction,folder,mailbox,message_id,in_reply_to,references_header,
    from_name,from_address,reply_to_address,to_addresses,cc_addresses,bcc_addresses,
    subject,preview,text_body,raw_r2_key,has_attachments,is_read,is_starred,sent_at,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id,
    `outbound:${input.providerMessageId || id}`,
    "outbound",
    "sent",
    env.MAILBOX_ADDRESS,
    input.providerMessageId || null,
    input.inReplyTo,
    input.references,
    env.MAILBOX_NAME,
    env.MAILBOX_ADDRESS,
    env.MAILBOX_ADDRESS,
    JSON.stringify(input.to),
    JSON.stringify(input.cc),
    JSON.stringify(input.bcc),
    input.subject || "(no subject)",
    preview(input.body),
    input.body.slice(0, MAX_STORED_BODY),
    null,
    0,
    1,
    0,
    now,
    now,
  ).run();
  return id;
}
