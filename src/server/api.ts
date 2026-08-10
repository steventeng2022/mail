import type { MailFolder } from "../shared/types";
import {
  getAttachmentRow,
  getCounts,
  getMessage,
  getRawMessageKey,
  listMessages,
  storeSentMessage,
  updateMessage,
} from "./storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function forbidden() {
  return json({ error: "This mailbox is private." }, { status: 403 });
}

function isAuthorized(request: Request, env: Env) {
  const identity = request.headers.get("cf-access-authenticated-user-email")?.trim().toLowerCase();
  return Boolean(identity && identity === env.ADMIN_EMAIL.toLowerCase());
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).origin !== new URL(request.url).origin) throw new Error("Invalid request origin");
}

function addresses(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Recipients must be a list");
  const result = [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (result.some((item) => !EMAIL.test(item) || item.length > 254)) throw new Error("One or more email addresses are invalid");
  return result;
}

async function readJson(request: Request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 800_000) throw new Error("Request is too large");
  return request.json() as Promise<Record<string, unknown>>;
}

function safeDownloadName(value: string) {
  return value.replace(/[\\"\r\n]/g, "_").slice(0, 180);
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return forbidden();
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (request.method === "GET" && path === "/api/session") {
      return json({
        session: {
          email: env.ADMIN_EMAIL,
          mailboxAddress: env.MAILBOX_ADDRESS,
          mailboxName: env.MAILBOX_NAME,
        },
        counts: await getCounts(env),
      });
    }

    if (request.method === "GET" && path === "/api/messages") {
      const requested = url.searchParams.get("folder") || "inbox";
      const folder: MailFolder = ["inbox", "sent", "starred", "trash"].includes(requested)
        ? requested as MailFolder
        : "inbox";
      const messages = await listMessages(env, folder, url.searchParams.get("q") || "");
      return json({ messages, counts: await getCounts(env) });
    }

    const messageMatch = /^\/api\/messages\/([0-9a-f-]+)$/.exec(path);
    if (messageMatch && UUID.test(messageMatch[1])) {
      const id = messageMatch[1];
      if (request.method === "GET") {
        const message = await getMessage(env, id, true);
        return message ? json({ message, counts: await getCounts(env) }) : json({ error: "Message not found" }, { status: 404 });
      }
      if (request.method === "PATCH") {
        assertSameOrigin(request);
        const body = await readJson(request);
        const folder = typeof body.folder === "string" && ["inbox", "sent", "trash"].includes(body.folder)
          ? body.folder as "inbox" | "sent" | "trash"
          : undefined;
        await updateMessage(env, id, {
          isRead: typeof body.isRead === "boolean" ? body.isRead : undefined,
          isStarred: typeof body.isStarred === "boolean" ? body.isStarred : undefined,
          folder,
        });
        return json({ ok: true, counts: await getCounts(env) });
      }
    }

    const rawMatch = /^\/api\/messages\/([0-9a-f-]+)\/raw$/.exec(path);
    if (request.method === "GET" && rawMatch && UUID.test(rawMatch[1])) {
      const record = await getRawMessageKey(env, rawMatch[1]);
      if (!record?.raw_r2_key) return json({ error: "Original message is unavailable" }, { status: 404 });
      const object = await env.MAIL_BUCKET.get(record.raw_r2_key);
      if (!object) return json({ error: "Original message is unavailable" }, { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": "message/rfc822",
          "content-disposition": `attachment; filename="message-${rawMatch[1]}.eml"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const attachmentMatch = /^\/api\/attachments\/([0-9a-f-]+)$/.exec(path);
    if (request.method === "GET" && attachmentMatch && UUID.test(attachmentMatch[1])) {
      const part = await getAttachmentRow(env, attachmentMatch[1]);
      if (!part) return json({ error: "Attachment not found" }, { status: 404 });
      const object = await env.MAIL_BUCKET.get(part.r2_key);
      if (!object) return json({ error: "Attachment not found" }, { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": part.mime_type,
          "content-length": String(part.size),
          "content-disposition": `attachment; filename="${safeDownloadName(part.filename)}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (request.method === "POST" && path === "/api/send") {
      assertSameOrigin(request);
      const body = await readJson(request);
      const to = addresses(body.to);
      const cc = addresses(body.cc ?? []);
      const bcc = addresses(body.bcc ?? []);
      if (!to.length) throw new Error("Add at least one recipient");
      if (to.length + cc.length + bcc.length > 50) throw new Error("A message can have at most 50 recipients");
      const subject = String(body.subject ?? "").trim().slice(0, 500);
      const text = String(body.text ?? "").trim().slice(0, 750_000);
      if (!text) throw new Error("Write a message before sending");

      let inReplyTo: string | null = null;
      let references: string | null = null;
      const replyToId = String(body.replyToId ?? "");
      if (UUID.test(replyToId)) {
        const original = await env.DB.prepare("SELECT message_id,references_header FROM mail_messages WHERE id=?")
          .bind(replyToId)
          .first<{ message_id: string | null; references_header: string | null }>();
        inReplyTo = original?.message_id ?? null;
        references = [original?.references_header, original?.message_id].filter(Boolean).join(" ") || null;
      }

      const headers: Record<string, string> = {};
      if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
      if (references) headers.References = references;
      const result = await env.EMAIL.send({
        from: { name: env.MAILBOX_NAME, email: env.MAILBOX_ADDRESS },
        to,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        subject: subject || "(no subject)",
        text,
        replyTo: env.MAILBOX_ADDRESS,
        ...(Object.keys(headers).length ? { headers } : {}),
      });
      const id = await storeSentMessage(env, {
        providerMessageId: result.messageId,
        to,
        cc,
        bcc,
        subject: subject || "(no subject)",
        body: text,
        inReplyTo,
        references,
      });
      console.log(JSON.stringify({ event: "mail_sent", id, providerMessageId: result.messageId, recipientCount: to.length + cc.length + bcc.length }));
      return json({ ok: true, id }, { status: 201 });
    }

    return json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request failed";
    console.error(JSON.stringify({ event: "mail_api_error", path, method: request.method, message }));
    return json({ error: message }, { status: 400 });
  }
}
