import type { Bindings } from "./api-context";
import { AppError } from "./app-error";
import { isoNow } from "./entity-utils";
import { randomToken } from "./auth-crypto";
import { decryptHybragGrant, encryptHybragGrant } from "./hybrag-grant-encryption";
import { checkHybragPlatformGrant } from "./hybrag-platform-grant";
import { sha256 } from "./hash-utils";

type Owner = { userId: string; workspaceId: string; subject: string };
type Row = { id: string; subject: string; secret_encrypted: string; state: "active" | "revoking"; version: number };

// These helpers do not constitute authorization. Callers must authenticate the
// owner, enforce explicit consent and verify platform and target permissions.
export const saveHybragDelegation = async (env: Bindings, owner: Owner, secret: string) => {
  const encrypted = await encryptHybragGrant(secret, owner, env);
  // Never overwrite a live or revoking delegation: a lost response or an old
  // request must not discard the only credential capable of remote revocation.
  const row = await env.storage.db.prepare(`INSERT INTO hybrag_delegations
    (id,user_id,workspace_id,subject,secret_encrypted,secret_hash,state,version,updated_at) VALUES (?,?,?,?,?,?,'active',1,?)
    ON CONFLICT DO NOTHING RETURNING version`).bind(randomToken(24), owner.userId, owner.workspaceId, owner.subject, encrypted, await sha256(secret), isoNow()).first();
  if (!row) throw new AppError("hybrag_delegation_exists", "Revoke the existing delegation before replacing it.", 409);
};

export const readHybragDelegation = async (env: Bindings, owner: Owner, requiredState: "active" | "revoking") => {
  const row = await env.storage.db.prepare(`SELECT id,subject,secret_encrypted,state,version FROM hybrag_delegations
    WHERE user_id = ? AND workspace_id = ?`).bind(owner.userId, owner.workspaceId).first<Row>();
  if (!row || row.subject !== owner.subject || row.state !== requiredState) return null;
  return { id: row.id, secret: await decryptHybragGrant(row.secret_encrypted, owner, env), version: row.version };
};

export const readVerifiedHybragDelegation = async (env: Bindings, owner: Owner) => {
  const grant = await readHybragDelegation(env, owner, "active");
  if (!grant || !await checkHybragPlatformGrant(env, grant.secret, owner.subject)) return null;
  // Revocation can begin during the network call. Never use the earlier row
  // after it was changed or replaced while checking the platform.
  const current = await env.storage.db.prepare(`SELECT d.id FROM hybrag_delegations d
    JOIN users u ON u.id = d.user_id AND u.is_disabled = 0
    JOIN user_identities i ON i.user_id = u.id AND i.provider = 'vos' AND i.subject = d.subject
    JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = d.workspace_id
    JOIN workspaces w ON w.id = m.workspace_id AND w.is_personal = 1 AND m.role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
    WHERE d.user_id = ? AND d.workspace_id = ? AND d.subject = ? AND d.id = ? AND d.version = ? AND d.state = 'active'`)
    .bind(owner.userId, owner.workspaceId, owner.subject, grant.id, grant.version).first();
  return current ? grant : null;
};

export const hybragExecutionProof = async (env: Bindings,owner: Owner,humanProof: string) => {
  const row=await env.storage.db.prepare("SELECT state,target_ready FROM hybrag_delegations WHERE user_id=? AND workspace_id=? AND subject=?")
    .bind(owner.userId,owner.workspaceId,owner.subject).first<{state:string;target_ready:number}>();
  if(!row) return {scheme:"Bearer" as const,secret:humanProof};
  if(row.state!=="active") throw new AppError("hybrag_grant_inactive","Integration authorization is being revoked.",403);
  if(row.target_ready!==1) throw new AppError("hybrag_control_pending","Background authorization has not reached HybRAG.",503);
  const grant=await readVerifiedHybragDelegation(env,owner);
  if(!grant) throw new AppError("hybrag_grant_inactive","Integration authorization is inactive.",403);
  return {scheme:"Integration" as const,secret:grant.secret};
};

export const beginHybragDelegationRevocation = async (env: Bindings, owner: Owner) => {
  return env.storage.db.prepare(`UPDATE hybrag_delegations SET state = 'revoking', version = version + 1, next_attempt_at = '', updated_at = ?
    WHERE user_id = ? AND workspace_id = ? AND subject = ? AND state = 'active' RETURNING id,version`)
    .bind(isoNow(), owner.userId, owner.workspaceId, owner.subject).first<{ id: string; version: number }>();
};

export const finishHybragDelegationRevocation = async (env: Bindings, owner: Owner, id: string, version: number) => {
  // Only call after the platform confirms revocation. CAS protects a newer row.
  return env.storage.db.prepare(`DELETE FROM hybrag_delegations WHERE user_id = ? AND workspace_id = ? AND subject = ?
    AND id = ? AND state = 'revoking' AND version = ? RETURNING version`)
    .bind(owner.userId, owner.workspaceId, owner.subject, id, version).first<{ version: number }>();
};
