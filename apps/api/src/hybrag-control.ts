import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { randomToken } from "./auth-crypto";
import { isoNow } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { verifyHybragProof, parseHybragProof, type HybragProofScheme } from "./hybrag-delegation-proof";
import { verifyHybragSessionIdentity } from "./hybrag-identity";
import { hybragTarget } from "./hybrag-note";

type Owner = { userId: string; workspaceId: string; subject: string };

const controlVersion = async (env: Bindings,owner: Owner) => {
  const current=await env.storage.db.prepare("SELECT version FROM hybrag_settings WHERE user_id=? AND workspace_id=?")
    .bind(owner.userId,owner.workspaceId).first<{version:number}>();
  if(current) return current;
  return env.storage.db.prepare("SELECT version FROM hybrag_control_events WHERE user_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1")
    .bind(owner.userId,owner.workspaceId).first<{version:number}>();
};

export const ensureHybragRevocationControl = async (env: Bindings,owner: Owner) => {
  // Settings may have cascaded away after account/workspace deletion. The
  // durable journal and encrypted grant intentionally survive that deletion.
  await env.storage.db.prepare(`INSERT INTO hybrag_control_events(user_id,workspace_id,version,enabled,roots_json)
    SELECT ?,?,COALESCE((SELECT MAX(version) FROM hybrag_control_events WHERE user_id=? AND workspace_id=?),0)+1,0,'[]'
    WHERE NOT EXISTS (SELECT 1 FROM hybrag_settings WHERE user_id=? AND workspace_id=?)
      AND COALESCE((SELECT enabled FROM hybrag_control_events WHERE user_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1),1)<>0`)
    .bind(owner.userId,owner.workspaceId,owner.userId,owner.workspaceId,owner.userId,owner.workspaceId,owner.userId,owner.workspaceId).run();
};

export const deliverHybragControl = async (env: Bindings, owner: Owner, proof: string, scheme: HybragProofScheme = "Bearer") => {
  const row = await controlVersion(env,owner);
  if (!row) return { pending: false, version: 0 };
  const token = randomToken(32), tokenHash = await sha256(token), now = isoNow();
  await env.storage.db.batch([
    env.storage.db.prepare("DELETE FROM hybrag_control_tickets WHERE user_id = ? AND expires_at <= ?").bind(owner.userId, now),
    env.storage.db.prepare(`INSERT INTO hybrag_control_tickets (token_hash,user_id,workspace_id,subject,version,expires_at)
      VALUES (?,?,?,?,?,?)`).bind(tokenHash, owner.userId, owner.workspaceId, owner.subject, row.version, new Date(Date.now() + 300000).toISOString()),
  ]);
  try {
    const response = await fetch(`${hybragTarget(env)}/api/v1/vnote/control`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `${scheme} ${proof}`, "Content-Type": "application/json" }, body: JSON.stringify({ ticket: token }),
    });
    if (!response.ok) return { pending: true, version: row.version };
    const result = await response.json() as { version?: unknown };
    if (result.version !== row.version) return { pending: true, version: row.version };
    const redeemed = await env.storage.db.prepare("SELECT consumed_at FROM hybrag_control_tickets WHERE token_hash = ?")
      .bind(tokenHash).first<{ consumed_at: string | null }>();
    if (!redeemed?.consumed_at) return { pending: true, version: row.version };
    await env.storage.db.prepare(`INSERT INTO hybrag_control_delivery (user_id,workspace_id,acknowledged_version) VALUES (?,?,?)
      ON CONFLICT (user_id,workspace_id) DO UPDATE SET acknowledged_version = MAX(acknowledged_version,excluded.acknowledged_version)`)
      .bind(owner.userId, owner.workspaceId, row.version).run();
    const current = await controlVersion(env,owner);
    return { pending: !current || current.version !== row.version, version: row.version };
  } catch {
    return { pending: true, version: row.version };
  } finally {
    await env.storage.db.prepare("DELETE FROM hybrag_control_tickets WHERE token_hash = ?").bind(tokenHash).run();
  }
};

export const redeemHybragControl = async (env: Bindings, token: string, proof: string, scheme: HybragProofScheme = "Bearer") => {
  const identity = await verifyHybragProof(env, proof, scheme, scheme === "Integration");
  const hash = await sha256(token), now = isoNow();
  const ticket = await env.storage.db.prepare(`UPDATE hybrag_control_tickets SET consumed_at = ?
    WHERE token_hash = ? AND subject = ? AND consumed_at IS NULL AND expires_at > ?
      AND (EXISTS (SELECT 1 FROM hybrag_settings s
        WHERE s.user_id = hybrag_control_tickets.user_id AND s.workspace_id = hybrag_control_tickets.workspace_id
          AND s.version = hybrag_control_tickets.version
          AND ((? <> '' AND s.enabled=0) OR EXISTS (SELECT 1 FROM users u
            JOIN user_identities i ON i.user_id=u.id AND i.provider='vos' AND i.subject=hybrag_control_tickets.subject
            JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=s.workspace_id
            JOIN workspaces w ON w.id=m.workspace_id AND w.is_personal=1 AND m.role='owner'
              AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
            WHERE u.id=s.user_id AND u.is_disabled=0)))
        OR (?<>'' AND NOT EXISTS (SELECT 1 FROM hybrag_settings s WHERE s.user_id=hybrag_control_tickets.user_id AND s.workspace_id=hybrag_control_tickets.workspace_id)
          AND EXISTS (SELECT 1 FROM hybrag_control_events e WHERE e.user_id=hybrag_control_tickets.user_id AND e.workspace_id=hybrag_control_tickets.workspace_id
            AND e.version=hybrag_control_tickets.version AND e.enabled=0)
          AND NOT EXISTS (SELECT 1 FROM hybrag_control_events e WHERE e.user_id=hybrag_control_tickets.user_id AND e.workspace_id=hybrag_control_tickets.workspace_id
            AND e.version>hybrag_control_tickets.version)))
      AND (? = '' OR EXISTS (SELECT 1 FROM hybrag_delegations d WHERE d.id=? AND d.version=?
        AND d.user_id=hybrag_control_tickets.user_id AND d.workspace_id=hybrag_control_tickets.workspace_id))
    RETURNING user_id,workspace_id,version`).bind(now, hash, identity.subject, now, identity.grantId??"",identity.grantId??"",
      identity.grantId??"",identity.grantId??"",identity.grantVersion??0)
    .first<{ user_id: string; workspace_id: string; version: number }>();
  if (!ticket) throw new AppError("hybrag_control_ticket_invalid", "The control ticket is invalid or stale.", 409);
  const event = await env.storage.db.prepare(`SELECT enabled, roots_json FROM hybrag_control_events
    WHERE user_id = ? AND workspace_id = ? AND version = ?`).bind(ticket.user_id, ticket.workspace_id, ticket.version)
    .first<{ enabled: number; roots_json: string }>();
  if (!event) throw new AppError("hybrag_control_unavailable", "The control snapshot is unavailable.", 503);
  if (scheme === "Integration" && event.enabled === 1) await verifyHybragProof(env, proof, scheme);
  return { protocol: 1, subject: identity.subject, workspaceId: ticket.workspace_id, version: ticket.version,
    enabled: event.enabled === 1, roots: JSON.parse(event.roots_json) as string[] };
};

export const registerHybragControlRoutes = (app: Hono<AppEnv>) => {
  app.post("/api/integrations/hybrag/redeem-control", bodyLimit({ maxSize: 32768 }),
    zValidator("json", z.object({ ticket: z.string().min(1).max(256) })), async (c) => {
      c.header("Cache-Control", "no-store");
      const proof = parseHybragProof(c.req.header("Authorization"));
      return c.json(await redeemHybragControl(c.env, c.req.valid("json").ticket, proof.secret, proof.scheme));
    });
  app.post("/api/v1/integrations/hybrag/deliver-control", bodyLimit({ maxSize: 32768 }),
    zValidator("json", z.object({ accessToken: z.string().min(1).max(16384) })), async (c) => {
      c.header("Cache-Control", "no-store");
      const proof = c.req.valid("json").accessToken;
      return c.json(await deliverHybragControl(c.env, await verifyHybragSessionIdentity(c, proof), proof));
    });
};
