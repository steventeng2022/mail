import { defineConfig, type Plugin } from "vite";

const now = Date.now();
const messages = [
  { id: "11111111-1111-4111-8111-111111111111", direction: "inbound", folder: "inbox", mailbox: "steven@steventeng.uk", fromName: "Cloudflare", fromAddress: "notifications@cloudflare.com", toAddresses: ["steven@steventeng.uk"], subject: "Your custom mailbox is ready", preview: "Email Routing is active and the first message has arrived safely.", hasAttachments: false, isRead: false, isStarred: true, sentAt: now - 1000 * 60 * 7 },
  { id: "22222222-2222-4222-8222-222222222222", direction: "inbound", folder: "inbox", mailbox: "steven@steventeng.uk", fromName: "GitHub", fromAddress: "noreply@github.com", toAddresses: ["steven@steventeng.uk"], subject: "Security alert resolved", preview: "The recent sign-in to your account was verified. No further action is needed.", hasAttachments: false, isRead: true, isStarred: false, sentAt: now - 1000 * 60 * 83 },
  { id: "33333333-3333-4333-8333-333333333333", direction: "inbound", folder: "inbox", mailbox: "steven@steventeng.uk", fromName: "Design Weekly", fromAddress: "hello@designweekly.co", toAddresses: ["steven@steventeng.uk"], subject: "Issue 248 — calm interfaces", preview: "This week: visual rhythm, purposeful motion, and the value of leaving room to breathe.", hasAttachments: true, isRead: true, isStarred: false, sentAt: now - 1000 * 60 * 60 * 26 },
];

function mockApi(): Plugin {
  return {
    name: "mail-preview-api",
    configurePreviewServer(server) {
      server.middlewares.use("/api", (request, response, next) => {
        response.setHeader("content-type", "application/json");
        const path = request.url || "";
        if (path.startsWith("/session")) return response.end(JSON.stringify({ session: { email: "steventeng2022@gmail.com", mailboxAddress: "steven@steventeng.uk", mailboxName: "Steven Teng" }, counts: { inbox: 3, unread: 1, sent: 4, starred: 1, trash: 0 } }));
        if (path.startsWith("/messages?")) return response.end(JSON.stringify({ messages, counts: { inbox: 3, unread: 1, sent: 4, starred: 1, trash: 0 } }));
        const found = messages.find((item) => path.includes(item.id));
        if (found && request.method === "GET") return response.end(JSON.stringify({ message: { ...found, replyToAddress: found.fromAddress, ccAddresses: [], bccAddresses: [], textBody: "Hello Steven,\n\nYour new private mailbox is connected and ready. Incoming messages are archived in R2 while the searchable inbox stays fast in D1.\n\nThis preview verifies the reading experience before production mail is enabled.\n\n— Steven Mail", attachments: found.hasAttachments ? [{ id: "44444444-4444-4444-8444-444444444444", filename: "interface-notes.pdf", mimeType: "application/pdf", size: 248320 }] : [] }, counts: { inbox: 3, unread: 1, sent: 4, starred: 1, trash: 0 } }));
        if (request.method === "PATCH") return response.end(JSON.stringify({ ok: true, counts: { inbox: 3, unread: 1, sent: 4, starred: 1, trash: 0 } }));
        if (path.startsWith("/send")) return response.end(JSON.stringify({ ok: true, id: crypto.randomUUID() }));
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [mockApi()],
  build: { outDir: "dist/client" },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
});
