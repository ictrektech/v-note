import type { Bindings } from "./api-context";
import { AppError } from "./app-error";
import { sha256 } from "./hash-utils";
import { checkHybragPlatformGrant } from "./hybrag-platform-grant";
import { verifyVosAccessToken } from "./vos-auth";
import { isVosMode } from "./vos-mode";

export type HybragProof = { subject: string; userId?: string; workspaceId?: string; grantId?: string; grantVersion?: number };
export type HybragProofScheme = "Bearer" | "Integration";

export const parseHybragProof = (header: string | undefined) => {
  const parsed = /^(Bearer|Integration)\s+([^\s]+)$/i.exec(header ?? "");
  if (!parsed || parsed[2].length > 16384) throw new AppError("hybrag_vos_proof_required", "Integration authorization is required.", 401);
  return { scheme: (/^Integration$/i.test(parsed[1]) ? "Integration" : "Bearer") as HybragProofScheme, secret: parsed[2] };
};

// Possession of a platform status credential is insufficient by itself. It
// must be the exact credential stored by this source's consenting owner.
export const verifyHybragProof = async (env: Bindings, secret: string, scheme: HybragProofScheme = "Bearer", denyOnly = false): Promise<HybragProof> => {
  if (!isVosMode(env)) throw new AppError("hybrag_vos_required", "VOS is required.", 403);
  if (scheme === "Bearer") return verifyVosAccessToken(env, secret, { requireHuman: true });
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new AppError("hybrag_grant_invalid", "Invalid integration authorization.", 401);
  const row = await env.storage.db.prepare(`SELECT id,user_id,workspace_id,subject,state,version FROM hybrag_delegations WHERE secret_hash = ?`)
    .bind(await sha256(secret)).first<{ id: string; user_id: string; workspace_id: string; subject: string; state: string; version: number }>();
  if (!row || (!denyOnly && row.state !== "active")) throw new AppError("hybrag_grant_inactive", "Integration authorization is inactive.", 403);
  if (!denyOnly && !await checkHybragPlatformGrant(env, secret, row.subject)) throw new AppError("hybrag_grant_inactive", "Integration authorization is inactive.", 403);
  const current = await env.storage.db.prepare(`SELECT id FROM hybrag_delegations WHERE id = ? AND version = ? AND secret_hash = ? AND (? = 1 OR state = 'active')`)
    .bind(row.id, row.version, await sha256(secret), denyOnly ? 1 : 0).first();
  if (!current) throw new AppError("hybrag_grant_inactive", "Integration authorization changed.", 403);
  if (!denyOnly) {
    const owner = await env.storage.db.prepare(`SELECT u.id FROM users u
      JOIN user_identities i ON i.user_id=u.id AND i.provider='vos' AND i.subject=?
      JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=?
      JOIN workspaces w ON w.id=m.workspace_id AND w.is_personal=1 AND m.role='owner'
        AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
      WHERE u.id=? AND u.is_disabled=0`).bind(row.subject, row.workspace_id, row.user_id).first();
    if (!owner) throw new AppError("hybrag_grant_inactive", "Integration ownership is unavailable.", 403);
  }
  return { subject: row.subject, userId: row.user_id, workspaceId: row.workspace_id, grantId: row.id, grantVersion: row.version };
};

// Include this predicate at the durable consume boundary, after remote checks.
export const HYBRAG_GRANT_CURRENT = `(? = '' OR EXISTS (SELECT 1 FROM hybrag_delegations d WHERE d.id = ? AND d.version = ? AND d.state = 'active'))`;
export const hybragGrantParameters = (proof: HybragProof) => [proof.grantId ?? "", proof.grantId ?? "", proof.grantVersion ?? 0] as const;
