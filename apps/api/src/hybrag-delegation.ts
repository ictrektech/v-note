import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { randomToken } from "./auth-crypto";
import { isoNow } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { encryptHybragGrant, decryptHybragGrant } from "./hybrag-grant-encryption";
import { verifyHybragSessionIdentity } from "./hybrag-identity";
import { requireHybragSettingsSession } from "./hybrag-settings";
import { queryHybragStatus } from "./hybrag-note";
import { deliverHybragControl, ensureHybragRevocationControl } from "./hybrag-control";
import { issueHybragPlatformGrant, revokeHybragPlatformGrant } from "./hybrag-platform-grant";
import { readHybragDelegation, readVerifiedHybragDelegation, beginHybragDelegationRevocation, finishHybragDelegationRevocation } from "./hybrag-delegation-store";
import { isVosMode } from "./vos-mode";

type Owner = { userId: string; workspaceId: string; subject: string };
const retryAt = (failures: number) => new Date(Date.now() + Math.min(900000, 15000 * 2 ** Math.min(failures, 6))).toISOString();

export const enableHybragDelegation = async (env: Bindings, owner: Owner, humanProof: string, expectedVersion: number) => {
  // Check encryption before a remote side effect; never fall back to plaintext.
  if (!env.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY?.trim()) throw new AppError("hybrag_encryption_unavailable", "Credential encryption is unavailable.", 503);
  const settings=await env.storage.db.prepare("SELECT version,schedule_json FROM hybrag_settings WHERE user_id=? AND workspace_id=? AND enabled=1 AND version=?")
    .bind(owner.userId,owner.workspaceId,expectedVersion).first<{version:number;schedule_json:string}>();
  if(!settings) throw new AppError("hybrag_authorization_changed", "Synchronization settings changed.", 409);
  const existing = await readHybragDelegation(env, owner, "active");
  if (existing) {
    if (!await readVerifiedHybragDelegation(env, owner)) throw new AppError("hybrag_grant_inactive", "The previous authorization is inactive; wait for revocation before enabling again.", 409);
    return { state: "active" as const };
  }
  if (await readHybragDelegation(env, owner, "revoking")) throw new AppError("hybrag_revocation_pending", "Previous authorization is being revoked.", 409);
  const target = await queryHybragStatus(env, humanProof);
  if (target.backgroundAuthorization !== 1) throw new AppError("hybrag_upgrade_required", "HybRAG background authorization is unavailable; check its version and encryption configuration.", 409);
  if(JSON.parse(settings.schedule_json).mode!=="manual"&&target.backgroundSync!==1) throw new AppError("hybrag_upgrade_required","Upgrade HybRAG before enabling automatic schedules.",409);
  const operation = randomToken(24), now = isoNow();
  const claim = await env.storage.db.prepare(`INSERT INTO hybrag_delegation_issuance(user_id,workspace_id,operation_id,lease_until)
    SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM hybrag_settings WHERE user_id=? AND workspace_id=? AND version=? AND enabled=1)
    ON CONFLICT(user_id,workspace_id) DO UPDATE SET operation_id=excluded.operation_id,lease_until=excluded.lease_until
      WHERE hybrag_delegation_issuance.lease_until<=? RETURNING operation_id`)
    .bind(owner.userId,owner.workspaceId,operation,new Date(Date.now()+60000).toISOString(),owner.userId,owner.workspaceId,expectedVersion,now).first();
  if (!claim) throw new AppError("hybrag_authorization_pending", "Authorization or settings changed. Retry after the current operation finishes.", 409);
  try {
    const secret = await issueHybragPlatformGrant(env,humanProof,owner.subject);
    const encrypted = await encryptHybragGrant(secret,owner,env), hash = await sha256(secret);
    // If publication of this credential fails, the durable outbox still owns
    // the only copy needed to revoke it. It never grants source reads.
    await env.storage.db.prepare(`INSERT INTO hybrag_grant_revocations(secret_hash,user_id,workspace_id,subject,secret_encrypted,next_attempt_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(hash,owner.userId,owner.workspaceId,owner.subject,encrypted,new Date(Date.now()+60000).toISOString()).run();
    const saved = await env.storage.db.prepare(`INSERT INTO hybrag_delegations(id,user_id,workspace_id,subject,secret_encrypted,secret_hash,state,version,updated_at)
      SELECT ?,?,?,?,?,?,'active',1,? FROM hybrag_delegation_issuance r
      JOIN hybrag_settings s ON s.user_id=r.user_id AND s.workspace_id=r.workspace_id AND s.enabled=1 AND s.version=?
      JOIN users u ON u.id=s.user_id AND u.is_disabled=0
      JOIN user_identities i ON i.user_id=u.id AND i.provider='vos' AND i.subject=?
      JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=s.workspace_id
      JOIN workspaces w ON w.id=m.workspace_id AND w.is_personal=1 AND m.role='owner'
        AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
      WHERE r.user_id=? AND r.workspace_id=? AND r.operation_id=? AND r.lease_until>? ON CONFLICT DO NOTHING RETURNING id`)
      .bind(randomToken(24),owner.userId,owner.workspaceId,owner.subject,encrypted,hash,isoNow(),expectedVersion,owner.subject,
        owner.userId,owner.workspaceId,operation,isoNow()).first();
    if (!saved) throw new AppError("hybrag_authorization_changed", "Authorization settings changed during consent.", 409);
    await env.storage.db.prepare("DELETE FROM hybrag_grant_revocations WHERE secret_hash=?").bind(hash).run();
    return { state: "active" as const };
  } finally {
    await env.storage.db.prepare("DELETE FROM hybrag_delegation_issuance WHERE user_id=? AND workspace_id=? AND operation_id=?")
      .bind(owner.userId,owner.workspaceId,operation).run();
  }
};

// Bounded maintenance only: durable control delivery and revocation. It does
// not scan note bodies, start models, or create authorization in the background.
export const maintainHybragDelegations = async (env: Bindings) => {
  if (!isVosMode(env)) return;
  const deadline=Date.now()+20000;
  const orphaned = await env.storage.db.prepare(`SELECT * FROM hybrag_grant_revocations WHERE next_attempt_at<=? ORDER BY next_attempt_at,secret_hash LIMIT 8`)
    .bind(isoNow()).all<{ secret_hash: string; user_id: string; workspace_id: string; subject: string; secret_encrypted: string; failures: number }>();
  for (const row of orphaned.results) {
    if(Date.now()>=deadline) break;
    // A crash between saving a grant and deleting its outbox entry must not
    // revoke the successfully published credential.
    const active = await env.storage.db.prepare("SELECT id FROM hybrag_delegations WHERE secret_hash=?").bind(row.secret_hash).first();
    if (active) { await env.storage.db.prepare("DELETE FROM hybrag_grant_revocations WHERE secret_hash=?").bind(row.secret_hash).run(); continue; }
    try {
      const owner = { userId: row.user_id, workspaceId: row.workspace_id, subject: row.subject };
      await revokeHybragPlatformGrant(env,await decryptHybragGrant(row.secret_encrypted,owner,env));
      await env.storage.db.prepare("DELETE FROM hybrag_grant_revocations WHERE secret_hash=?").bind(row.secret_hash).run();
    } catch {
      await env.storage.db.prepare("UPDATE hybrag_grant_revocations SET failures=failures+1,next_attempt_at=? WHERE secret_hash=?")
        .bind(retryAt(row.failures),row.secret_hash).run();
    }
  }
  const rows = await env.storage.db.prepare(`SELECT id,user_id,workspace_id,subject,state,version,failures,target_ready FROM hybrag_delegations
    WHERE next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 16`).bind(isoNow())
    .all<{ id: string; user_id: string; workspace_id: string; subject: string; state: "active" | "revoking"; version: number; failures: number; target_ready: number }>();
  for (const row of rows.results) {
    if(Date.now()>=deadline) break;
    const claimed = await env.storage.db.prepare("UPDATE hybrag_delegations SET next_attempt_at=? WHERE id=? AND version=? AND next_attempt_at<=? RETURNING id")
      .bind(new Date(Date.now()+60000).toISOString(),row.id,row.version,isoNow()).first();
    if (!claimed) continue;
    const owner = { userId: row.user_id, workspaceId: row.workspace_id, subject: row.subject };
    try {
      if (row.state === "active") {
        const enabled = await env.storage.db.prepare("SELECT enabled FROM hybrag_settings WHERE user_id=? AND workspace_id=?")
          .bind(owner.userId,owner.workspaceId).first<{ enabled: number }>();
        const valid = enabled?.enabled === 1 ? await readVerifiedHybragDelegation(env,owner) : null;
        if (!valid) { await beginHybragDelegationRevocation(env,owner); continue; }
        const pending = await env.storage.db.prepare(`SELECT s.version FROM hybrag_settings s LEFT JOIN hybrag_control_delivery d
          ON d.user_id=s.user_id AND d.workspace_id=s.workspace_id WHERE s.user_id=? AND s.workspace_id=? AND COALESCE(d.acknowledged_version,0)<s.version`)
          .bind(owner.userId,owner.workspaceId).first();
        if (!row.target_ready || pending) {
          const delivery = await deliverHybragControl(env,owner,valid.secret,"Integration");
          if (delivery.pending) throw new AppError("hybrag_control_pending", "Control delivery is pending.", 503);
          await env.storage.db.prepare("UPDATE hybrag_delegations SET target_ready=1 WHERE id=? AND version=? AND state='active'").bind(row.id,row.version).run();
        }
      } else {
        const grant = await readHybragDelegation(env,owner,"revoking");
        if (!grant || grant.id!==row.id || grant.version!==row.version) continue;
        await revokeHybragPlatformGrant(env,grant.secret);
        await ensureHybragRevocationControl(env,owner);
        const delivery = await deliverHybragControl(env,owner,grant.secret,"Integration");
        if (delivery.pending || delivery.version===0) throw new AppError("hybrag_control_pending", "Revocation delivery is pending.", 503);
        await finishHybragDelegationRevocation(env,owner,row.id,row.version);
      }
      await env.storage.db.prepare("UPDATE hybrag_delegations SET failures=0,next_attempt_at=? WHERE id=? AND version=?")
        .bind(new Date(Date.now()+30000).toISOString(),row.id,row.version).run();
    } catch {
      await env.storage.db.prepare("UPDATE hybrag_delegations SET failures=failures+1,next_attempt_at=? WHERE id=? AND version=?")
        .bind(retryAt(row.failures),row.id,row.version).run();
    }
  }
};

export const registerHybragDelegationRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/v1/integrations/hybrag/delegation", async (c) => {
    c.header("Cache-Control","no-store");
    const owner=await requireHybragSettingsSession(c);
    const row=await c.env.storage.db.prepare("SELECT state,target_ready FROM hybrag_delegations WHERE user_id=? AND workspace_id=?")
      .bind(owner.userId,owner.workspaceId).first<{state:string;target_ready:number}>();
    const settings=await c.env.storage.db.prepare(`SELECT s.enabled,s.roots_json,s.version,s.schedule_json,s.paused_roots_json,COALESCE(d.acknowledged_version,0) AS acknowledged
      FROM hybrag_settings s LEFT JOIN hybrag_control_delivery d ON d.user_id=s.user_id AND d.workspace_id=s.workspace_id
      WHERE s.user_id=? AND s.workspace_id=?`).bind(owner.userId,owner.workspaceId)
      .first<{enabled:number;roots_json:string;version:number;schedule_json:string;paused_roots_json:string;acknowledged:number}>();
    return c.json({state:row?.state??"disabled",targetReady:row?.state==="active"&&row.target_ready===1,
      settings:settings?{enabled:settings.enabled===1,roots:JSON.parse(settings.roots_json),pausedRoots:JSON.parse(settings.paused_roots_json),capabilities:{rootPause:1},schedule:JSON.parse(settings.schedule_json),version:settings.version,controlPending:settings.acknowledged<settings.version}:undefined});
  });
  app.post("/api/v1/integrations/hybrag/delegation",bodyLimit({maxSize:32768}),
    zValidator("json",z.object({accessToken:z.string().min(1).max(16384),version:z.number().int().min(1),consent:z.literal(true)})),async(c)=>{
      c.header("Cache-Control","no-store");
      const input=c.req.valid("json"),owner=await verifyHybragSessionIdentity(c,input.accessToken);
      const result=await enableHybragDelegation(c.env,owner,input.accessToken,input.version);
      c.executionCtx.waitUntil(maintainHybragDelegations(c.env));
      return c.json(result);
    });
  app.delete("/api/v1/integrations/hybrag/delegation",async(c)=>{
    c.header("Cache-Control","no-store");
    const owner=await requireHybragSettingsSession(c);
    const row=await c.env.storage.db.prepare("SELECT subject FROM hybrag_delegations WHERE user_id=? AND workspace_id=?")
      .bind(owner.userId,owner.workspaceId).first<{subject:string}>();
    if(row) await beginHybragDelegationRevocation(c.env,{...owner,subject:row.subject});
    c.executionCtx.waitUntil(maintainHybragDelegations(c.env));
    return c.json({state:row?"revoking":"disabled"});
  });
};
