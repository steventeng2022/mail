import { handleApi } from "./server/api";
import { storeIncomingMessage } from "./server/storage";

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (headers.get("content-type")?.includes("text/html")) headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (!message.to.toLowerCase().endsWith("@steventeng.uk")) {
      message.setReject("Unknown mailbox domain");
      return;
    }
    const id = await storeIncomingMessage(message, env);
    console.log(JSON.stringify({ event: "mail_received", id, from: message.from, to: message.to, bytes: message.rawSize }));
  },
} satisfies ExportedHandler<Env>;
