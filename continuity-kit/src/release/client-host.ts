import { releasePolicy, validateReleaseProfile } from "./profile.ts";
import type { ReleaseProfile } from "./profile.ts";

export interface ClientAsset {
  contentType: string;
  base64: string;
}
export interface ClientHostEnv {
  // Operator runtime setting only. Never read from a request or public endpoint.
  CONTINUITY_PRIMARY_OFFLINE?: string;
}

/** Serve only embedded build assets. No database, signing or credential access. */
export function createClientHost(
  input: ReleaseProfile,
  role: "primary" | "recovery",
  assets: Readonly<Record<string, ClientAsset>>,
) {
  const profile = validateReleaseProfile(input);
  const policy = releasePolicy(profile);
  const origin = role === "primary" ? profile.aOrigin : profile.bOrigin;
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy":
      "publickey-credentials-create=(self), publickey-credentials-get=(self), camera=(), microphone=(), geolocation=()",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${profile.storeOrigin} ${policy.rpcUrls.join(" ")}`,
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join("; "),
    // A must retain the cross-origin B opener for the validated handoff.
    "cross-origin-opener-policy": "unsafe-none",
  };
  return (request: Request, env: ClientHostEnv = {}): Response => {
    const url = new URL(request.url);
    const head = request.method === "HEAD";
    const error = (status: number, message: string) =>
      new Response(head ? null : message, {
        status,
        headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
      });
    if (url.origin !== origin) return error(403, "Incorrect demo origin.");
    if (request.method !== "GET" && !head)
      return error(405, "This client serves GET and HEAD requests only.");
    if (Date.now() >= Date.parse(profile.expiresAt))
      return error(
        410,
        "This limited demonstration has ended. Access expiry does not delete stored copies or chain history.",
      );
    if (role === "primary" && env.CONTINUITY_PRIMARY_OFFLINE === "1")
      return error(
        503,
        "The primary demonstration is offline. Open the prepared recovery app to continue.",
      );
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!Object.hasOwn(assets, path)) return error(404, "Not found.");
    const asset = assets[path]!;
    return new Response(
      head ? null : Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0)),
      { headers: { ...headers, "content-type": asset.contentType } },
    );
  };
}
