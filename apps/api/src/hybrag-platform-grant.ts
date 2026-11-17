import type { Bindings } from "./api-context";
import { AppError } from "./app-error";

// Only use the explicitly configured platform origin. No fallback to OAuth
// refresh or application-admin credentials is permitted.
const endpoint = (env: Bindings, operation: "issue" | "status" | "revoke") => {
  const raw = env.EDGE_EVER_VOS_USERINFO_URL?.trim();
  if (!raw) throw new AppError("hybrag_platform_unavailable", "VOS identity service is not configured.", 503);
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError("hybrag_platform_unavailable", "VOS identity service is invalid.", 503); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/v1000/oauth2/userinfo") {
    throw new AppError("hybrag_platform_unavailable", "VOS identity service is invalid.", 503);
  }
  url.pathname = `/v1000/oauth2/integration-grant/${operation}`;
  return url.href;
};

const call = async (env: Bindings, operation: "issue" | "status" | "revoke", body: unknown, proof?: string) => {
  let response: Response;
  try {
    response = await fetch(endpoint(env, operation), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", ...(proof ? { Authorization: `Bearer ${proof}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch { throw new AppError("hybrag_platform_unavailable", "VOS grant service is unavailable.", 503); }
  if (!response.ok) throw new AppError("hybrag_platform_unavailable", "VOS grant service rejected the request.", 503);
  const text = await response.text();
  if (text.length > 4096) throw new AppError("hybrag_platform_unavailable", "VOS grant response is invalid.", 503);
  let result: { protocol?: unknown; secret?: unknown; active?: unknown; subject?: unknown };
  try { result = JSON.parse(text); } catch { throw new AppError("hybrag_platform_unavailable", "VOS grant response is invalid.", 503); }
  if (!result || result.protocol !== 1) throw new AppError("hybrag_platform_unavailable", "VOS grant protocol is unavailable.", 503);
  return result;
};

export const issueHybragPlatformGrant = async (env: Bindings, humanProof: string, expectedSubject: string) => {
  if (!humanProof || humanProof.length > 16384 || /[\r\n]/.test(humanProof)) throw new AppError("hybrag_vos_proof_required", "A current VOS user token is required.", 401);
  const result = await call(env, "issue", { consent: true }, humanProof);
  if (typeof result.secret !== "string" || !/^[0-9a-f]{64}$/.test(result.secret)) throw new AppError("hybrag_platform_unavailable", "VOS grant response is invalid.", 503);
  if (!expectedSubject || result.subject !== expectedSubject) {
    // The returned credential belongs to a different identity. Attempt to
    // invalidate it before rejecting; it must never be saved for this owner.
    try { await revokeHybragPlatformGrant(env, result.secret); } catch { /* It expires on the platform even if revocation is unavailable. */ }
    throw new AppError("hybrag_identity_mismatch", "The VOS grant does not match this session.", 403);
  }
  return result.secret;
};

export const checkHybragPlatformGrant = async (env: Bindings, secret: string, expectedSubject: string) => {
  if (!/^[0-9a-f]{64}$/.test(secret)) return false;
  const result = await call(env, "status", { secret });
  if (typeof result.active !== "boolean") throw new AppError("hybrag_platform_unavailable", "VOS grant response is invalid.", 503);
  if (result.active && (!expectedSubject || result.subject !== expectedSubject)) return false;
  return result.active;
};

export const revokeHybragPlatformGrant = async (env: Bindings, secret: string) => {
  if (!/^[0-9a-f]{64}$/.test(secret)) return;
  const result = await call(env, "revoke", { secret });
  if (result.active !== false) throw new AppError("hybrag_platform_unavailable", "VOS grant response is invalid.", 503);
};
