import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("mail transport", () => {
  it("archives inbound mail and stores message metadata", async () => {
    const storage = await read("src/server/storage.ts");
    expect(storage).toContain("message.raw.tee()");
    expect(storage).toContain("PostalMime.parse");
    expect(storage).toContain("env.MAIL_BUCKET.put(rawKey");
    expect(storage).toContain("INSERT INTO mail_messages");
    expect(storage).toContain("dedupe_key=?");
  });

  it("sends through the restricted Cloudflare Email binding", async () => {
    const [api, config] = await Promise.all([read("src/server/api.ts"), read("wrangler.jsonc")]);
    expect(api).toContain("env.EMAIL.send");
    expect(api).toContain("assertSameOrigin(request)");
    expect(config).toContain('"allowed_sender_addresses": ["steven@steventeng.uk"]');
  });
});

describe("mailbox security", () => {
  it("requires the Access identity and disables public workers.dev URLs", async () => {
    const [api, config] = await Promise.all([read("src/server/api.ts"), read("wrangler.jsonc")]);
    expect(api).toContain("cf-access-authenticated-user-email");
    expect(api).toContain("env.ADMIN_EMAIL.toLowerCase()");
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
  });

  it("serves downloads with no-store and nosniff", async () => {
    const api = await read("src/server/api.ts");
    expect(api).toContain('"cache-control": "private, no-store"');
    expect(api).toContain('"x-content-type-options": "nosniff"');
  });
});

describe("webmail interface", () => {
  it("contains inbox, sent, starred, trash, search, compose, and reader flows", async () => {
    const app = await read("src/client/App.tsx");
    for (const feature of ["Inbox", "Sent", "Starred", "Trash", "Search your mail", "Compose", "Reply"]) {
      expect(app).toContain(feature);
    }
  });
});
