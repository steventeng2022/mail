# Steven Mail

A private webmail application for `steven@steventeng.uk`, hosted independently at `mail.steventeng.uk` on Cloudflare Workers.

## Architecture

```text
Incoming email
  -> Cloudflare Email Service routing
  -> Worker email handler
  -> D1 (searchable inbox and message state)
  -> R2 (original .eml files and attachments)

mail.steventeng.uk
  -> Cloudflare Access
  -> React mailbox
  -> Worker API
  -> Cloudflare Email Service sending binding
```

The web UI supports Inbox, Sent, Starred, Trash, search, message reading, `.eml` downloads, attachment downloads, compose, and threaded reply headers. HTML mail is deliberately rendered as safe plain text; the untouched original remains available as an `.eml` download.

## Local development

```bash
npm install
npm run types
npx wrangler d1 migrations apply steven-mail --local
npm run dev
```

The Cloudflare Vite plugin runs the React client and Worker API together. Wrangler's local D1 and R2 bindings persist under `.wrangler/`.

## Production setup

1. Authenticate Wrangler with `npx wrangler login`.
2. Create the resources:

   ```bash
   npx wrangler d1 create steven-mail
   npx wrangler r2 bucket create steven-mail-storage
   ```

3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the returned D1 ID.
4. Apply the production schema:

   ```bash
   npx wrangler d1 migrations apply steven-mail --remote
   ```

5. Before exposing the site, create a Cloudflare Access self-hosted application for `mail.steventeng.uk` and allow only `steventeng2022@gmail.com`.
6. In Cloudflare Email Service, onboard `steventeng.uk` for Email Routing and Email Sending. Approve the MX, SPF, and DKIM records Cloudflare proposes.
7. Create an Email Routing rule for `steven@steventeng.uk` with the action **Send to a Worker**, selecting `steven-mail`.
8. Deploy:

   ```bash
   npm run deploy
   ```

The `custom_domain` route in `wrangler.jsonc` links the Worker to `mail.steventeng.uk`; Cloudflare creates the DNS record and certificate. Public `workers.dev` and preview URLs are disabled to prevent bypassing the Access policy.

## Verification

```bash
npm run check
```

This runs TypeScript checks, a production Vite/Worker build, and the mail/security test suite.

## Security notes

- The API accepts only the Cloudflare Access identity configured in `ADMIN_EMAIL`.
- State-changing requests enforce same-origin requests.
- Static pages and downloads receive restrictive security and no-store headers.
- Sender addresses are restricted to `steven@steventeng.uk` in the Email binding.
- Original email and attachments remain private in R2; only authenticated download endpoints expose them.
- Do not enable public `workers.dev` URLs for this project.
