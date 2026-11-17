import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  hasDiagramDocumentMarker, hasInfographicDocumentMarker, hasPosterDocumentMarker, hasTableDocumentMarker,
} from "@edgeever/shared";
import type { AppEnv, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { createId, isoNow } from "./entity-utils";
import { randomToken } from "./auth-crypto";
import { sha256 } from "./hash-utils";
import { verifyHybragSessionIdentity } from "./hybrag-identity";
import { verifyHybragProof, parseHybragProof, HYBRAG_GRANT_CURRENT, hybragGrantParameters, type HybragProofScheme } from "./hybrag-delegation-proof";
import { isVosMode } from "./vos-mode";
import { hybragExecutionProof } from "./hybrag-delegation-store";

type NoteRow = {
  id: string; title: string; content_markdown: string; content_hash: string;
  notebook_id: string; root_name: string; updated_at: string;
};

export const hybragNotebookScopeSQL = `WITH RECURSIVE selected(id) AS (
  SELECT id FROM notebooks WHERE id = ? AND workspace_id = ? AND is_deleted = 0
  UNION
  SELECT n.id FROM notebooks n JOIN selected s ON n.parent_id = s.id
    WHERE n.workspace_id = ? AND n.is_deleted = 0
), ancestors(id) AS (
  SELECT parent_id FROM notebooks WHERE id = ? AND workspace_id = ? AND is_deleted = 0 AND parent_id IS NOT NULL
  UNION
  SELECT n.parent_id FROM notebooks n JOIN ancestors a ON n.id = a.id
    WHERE n.workspace_id = ? AND n.is_deleted = 0 AND n.parent_id IS NOT NULL
)
`;
const noteQuery = `${hybragNotebookScopeSQL}
SELECT m.id, COALESCE(m.title, '') AS title, m.notebook_id, m.updated_at,
       c.content_markdown, c.content_hash, root.name AS root_name
FROM memos m JOIN memo_contents c ON c.memo_id = m.id
JOIN notebooks root ON root.id = ? AND root.workspace_id = m.workspace_id AND root.is_deleted = 0
WHERE m.id = ? AND m.workspace_id = ? AND m.is_deleted = 0 AND m.notebook_id IN (SELECT id FROM selected)`;

const readNote = async (env: Bindings, workspace: string, root: string, memo: string) => {
  const row = await env.storage.db.prepare(noteQuery).bind(root, workspace, workspace, root, workspace, workspace, root, memo, workspace).first<NoteRow>();
  if (!row) throw new AppError("hybrag_note_not_found", "The note is not in the selected notebook.", 404);
  const body = row.content_markdown;
  if (hasDiagramDocumentMarker(body) || hasInfographicDocumentMarker(body) || hasPosterDocumentMarker(body) || hasTableDocumentMarker(body)) {
    throw new AppError("hybrag_note_type_unsupported", "This integration currently supports prose notes only.", 422);
  }
  if (/!\[|<(?:img|video|audio|iframe|object|embed|script)\b|(?:resource|storage|file):\/\/|\/api\/v1\/resources\//i.test(`${row.title}\n${body}`)) {
    throw new AppError("hybrag_note_resources_unsupported", "Notes containing embedded resources are not supported yet.", 422);
  }
  if (!body.trim() || Array.from(body).length > 180000) {
    throw new AppError("hybrag_note_size_unsupported", "The note must contain between 1 and 180000 characters.", 422);
  }
  return row;
};

export const requireHybragScope = async (env: Bindings, identity: { userId: string; workspaceId: string }, rootId: string) => {
  const settings = await env.storage.db.prepare(`${hybragNotebookScopeSQL} SELECT version FROM hybrag_settings s
    WHERE s.user_id = ? AND s.workspace_id = ? AND s.enabled = 1
      AND EXISTS (SELECT 1 FROM hybrag_control_delivery d WHERE d.user_id = s.user_id AND d.workspace_id = s.workspace_id AND d.acknowledged_version = s.version)
      AND EXISTS (SELECT 1 FROM selected WHERE id = ?)
      AND EXISTS (SELECT 1 FROM json_each(s.roots_json) WHERE value = ?)
      AND NOT EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) p WHERE p.value IN (SELECT id FROM selected))
      AND NOT EXISTS (SELECT 1 FROM json_each(s.roots_json) r WHERE r.value <> ? AND
        (r.value IN (SELECT id FROM selected) OR r.value IN (SELECT id FROM ancestors)))`)
    .bind(rootId, identity.workspaceId, identity.workspaceId, rootId, identity.workspaceId, identity.workspaceId,
      identity.userId, identity.workspaceId, rootId, rootId, rootId).first<{ version: number }>();
  if (!settings) throw new AppError("hybrag_scope_denied", "The notebook is not enabled for synchronization.", 403);
  return settings.version;
};

export const mintHybragNoteTicket = async (env: Bindings, identity: { userId: string; workspaceId: string; subject: string }, rootId: string, memoId: string) => {
  const version = await requireHybragScope(env, identity, rootId);
  const note = await readNote(env, identity.workspaceId, rootId, memoId);
  const token = randomToken(32);
  const id = createId("hgt");
  const now = isoNow();
  await env.storage.db.batch([
    env.storage.db.prepare("DELETE FROM hybrag_note_tickets WHERE user_id = ? AND expires_at <= ?").bind(identity.userId, now),
    env.storage.db.prepare(`INSERT INTO hybrag_note_tickets
      (id,token_hash,user_id,workspace_id,subject,root_id,memo_id,source_hash,source_title,expires_at,config_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(id, await sha256(token), identity.userId, identity.workspaceId, identity.subject, rootId, memoId,
      note.content_hash, note.title, new Date(Date.now() + 5 * 60 * 1000).toISOString(), version),
  ]);
  return { id, token };
};

export const redeemHybragNoteTicket = async (env: Bindings, token: string, accessToken: string, scheme: HybragProofScheme = "Bearer") => {
  if (!isVosMode(env)) throw new AppError("hybrag_vos_required", "VOS is required.", 403);
  const identity = await verifyHybragProof(env, accessToken, scheme);
  const tokenHash = await sha256(token);
  const ticket = await env.storage.db.prepare(`SELECT t.* FROM hybrag_note_tickets t
    JOIN users u ON u.id = t.user_id AND u.is_disabled = 0
    JOIN user_identities i ON i.user_id = u.id AND i.provider = 'vos' AND i.subject = t.subject
    JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = t.workspace_id
    JOIN workspaces w ON w.id = t.workspace_id AND w.is_personal = 1 AND wm.role='owner'
      AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
    JOIN hybrag_settings s ON s.user_id = t.user_id AND s.workspace_id = t.workspace_id
      AND s.enabled = 1 AND s.version = t.config_version
    JOIN hybrag_control_delivery d ON d.user_id = s.user_id AND d.workspace_id = s.workspace_id AND d.acknowledged_version = s.version
    WHERE t.token_hash = ? AND t.subject = ? AND t.consumed_at IS NULL AND t.expires_at > ?
      AND EXISTS (SELECT 1 FROM json_each(s.roots_json) WHERE value = t.root_id)`)
    .bind(tokenHash, identity.subject, isoNow()).first<{
      id: string; user_id: string; workspace_id: string; root_id: string; memo_id: string; source_hash: string; source_title: string; config_version: number;
    }>();
  if (!ticket) throw new AppError("hybrag_ticket_invalid", "The note ticket is invalid, expired or consumed.", 404);
  if (identity.grantId && (ticket.user_id !== identity.userId || ticket.workspace_id !== identity.workspaceId)) throw new AppError("hybrag_grant_invalid", "Integration ownership does not match this ticket.", 403);
  const note = await readNote(env, ticket.workspace_id, ticket.root_id, ticket.memo_id);
  if (note.content_hash !== ticket.source_hash || note.title !== ticket.source_title) {
    throw new AppError("hybrag_source_changed", "The note changed before synchronization. Retry the operation.", 409);
  }
  const claimed = await env.storage.db.prepare(`${hybragNotebookScopeSQL} UPDATE hybrag_note_tickets SET consumed_at = ?
    WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND ${HYBRAG_GRANT_CURRENT}
      AND EXISTS (SELECT 1 FROM hybrag_settings s, json_each(s.roots_json) r
        WHERE s.user_id = hybrag_note_tickets.user_id AND s.workspace_id = hybrag_note_tickets.workspace_id
          AND s.enabled = 1 AND s.version = hybrag_note_tickets.config_version AND r.value = hybrag_note_tickets.root_id
          AND NOT EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) p WHERE p.value=r.value)
          AND EXISTS (SELECT 1 FROM hybrag_control_delivery d WHERE d.user_id = s.user_id AND d.workspace_id = s.workspace_id AND d.acknowledged_version = s.version)
          AND NOT EXISTS (SELECT 1 FROM json_each(s.roots_json) other WHERE other.value <> r.value AND
            (other.value IN (SELECT id FROM selected) OR other.value IN (SELECT id FROM ancestors))))
      AND EXISTS (SELECT 1 FROM users u
        JOIN user_identities i ON i.user_id = u.id AND i.provider = 'vos' AND i.subject = hybrag_note_tickets.subject
        JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = hybrag_note_tickets.workspace_id
        JOIN workspaces w ON w.id = wm.workspace_id AND w.is_personal = 1 AND wm.role='owner'
          AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
        WHERE u.id = hybrag_note_tickets.user_id AND u.is_disabled = 0)
      AND EXISTS (SELECT 1 FROM memos m JOIN memo_contents c ON c.memo_id = m.id
        WHERE m.id = hybrag_note_tickets.memo_id AND m.is_deleted = 0 AND m.notebook_id = ?
          AND m.workspace_id = hybrag_note_tickets.workspace_id AND m.notebook_id IN (SELECT id FROM selected)
          AND c.content_hash = hybrag_note_tickets.source_hash AND COALESCE(m.title,'') = hybrag_note_tickets.source_title)
    RETURNING id`).bind(ticket.root_id, ticket.workspace_id, ticket.workspace_id, ticket.root_id, ticket.workspace_id, ticket.workspace_id,
      isoNow(), ticket.id, isoNow(), ...hybragGrantParameters(identity), note.notebook_id).first<{ id: string }>();
  if (!claimed) throw new AppError("hybrag_source_changed", "The note ticket cannot be consumed. Retry the operation.", 409);
  return { protocol: 1, subject: identity.subject, workspaceId: ticket.workspace_id, configVersion: ticket.config_version, rootId: ticket.root_id, rootName: note.root_name, noteId: note.id,
    notebookId: note.notebook_id, title: note.title, markdown: note.content_markdown, sourceHash: note.content_hash, updatedAt: note.updated_at };
};

export const hybragTarget = (env: Bindings) => {
  const target = new URL(env.EDGE_EVER_HYBRAG_URL ?? "http://hybrag-app:8080");
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new AppError("hybrag_target_invalid", "The HybRAG service address is invalid.", 503);
  }
  return target.href.replace(/\/$/, "");
};

export const queryHybragStatus = async (env: Bindings, proof: string, rootId = "", noteId = "", scheme: HybragProofScheme = "Bearer",syncScope?:{workspaceId:string;roots:string[]}) => {
  try {
    const response = await fetch(`${hybragTarget(env)}/api/v1/vnote/status`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `${scheme} ${proof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rootId, noteId,...(syncScope?{syncWorkspaceId:syncScope.workspaceId,syncRoots:syncScope.roots}:{}) }),
    });
    if (response.status === 404) throw new AppError("hybrag_upgrade_required", "HybRAG does not support this integration version.", 409);
    if (response.status === 409) throw new AppError("hybrag_identity_binding_required", "Verify your HybRAG account binding.", 409);
    if (!response.ok) throw new AppError("hybrag_status_unavailable", "HybRAG status is unavailable.", 503);
    const result = await response.json() as { connected?: boolean; backgroundAuthorization?: number; backgroundSync?: number; syncRuns?:{rootId:string;configVersion:number;state:string;errorCode?:string}[]; result?: { state?: string; attempt?: string } };
    if (result.connected !== true || (rootId && typeof result.result?.state !== "string")) throw new AppError("hybrag_response_invalid", "HybRAG returned an invalid status.", 502);
    if(syncScope&&(!Array.isArray(result.syncRuns)||result.syncRuns.length>100||result.syncRuns.some(row=>!syncScope.roots.includes(row.rootId)||typeof row.state!=="string")))throw new AppError("hybrag_response_invalid","HybRAG returned an invalid synchronization status.",502);
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("hybrag_unavailable", "HybRAG is unavailable.", 503);
  }
};

export const sendHybragNote = async (env: Bindings, identity: { userId: string; workspaceId: string; subject: string }, proof: string, rootId: string, memoId: string, scheme: HybragProofScheme = "Bearer") => {
  const ticket = await mintHybragNoteTicket(env, identity, rootId, memoId);
  try {
    const response = await fetch(`${hybragTarget(env)}/api/v1/vnote/import-note`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `${scheme} ${proof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: ticket.token }),
    });
    if (!response.ok) {
      if (response.status === 409) {
        const error = await response.json().catch(() => null) as { code?: string } | null;
        if (error?.code === "vnote_busy") throw new AppError("hybrag_busy", "Another V-Note note is being indexed. Retry after it finishes.", 409);
        if (error?.code === "identity_binding_required") throw new AppError("hybrag_identity_binding_required", "Verify your HybRAG account binding before synchronizing notes.", 409);
      }
      if (response.status === 422) {
        const error = await response.json().catch(() => null) as { code?: string; accepted?: boolean } | null;
        if (error?.code === "vnote_embedding_unavailable" && error.accepted === false) {
          throw new AppError("hybrag_embedding_unavailable", "Configure an active default embedding model in HybRAG, then retry.", 422);
        }
        throw new AppError("hybrag_model_or_storage", "Check HybRAG model and storage settings.", 422);
      }
      throw new AppError("hybrag_import_rejected", `HybRAG could not accept this note (HTTP ${response.status}).`, 502);
    }
    const result = await response.json() as { accepted?: unknown; knowledgeBaseId?: unknown; knowledgeId?: unknown; state?: unknown; attempt?: unknown };
    if (result.accepted !== true || typeof result.knowledgeBaseId !== "string" || typeof result.knowledgeId !== "string" || typeof result.state !== "string") {
      throw new AppError("hybrag_response_invalid", "HybRAG returned an invalid import response.", 502);
    }
    return { accepted: true, knowledgeBaseId: result.knowledgeBaseId, knowledgeId: result.knowledgeId, state: result.state,
      ...(typeof result.attempt === "string" && result.attempt.length > 0 && result.attempt.length <= 128 ? { attempt: result.attempt } : {}) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("hybrag_unavailable", "HybRAG is unavailable. Retry this note later.", 503);
  } finally {
    await env.storage.db.prepare("DELETE FROM hybrag_note_tickets WHERE id = ? AND user_id = ?").bind(ticket.id, identity.userId).run();
  }
};

export const registerHybragNoteRoutes = (app: Hono<AppEnv>) => {
  app.post("/api/integrations/hybrag/authorize", bodyLimit({ maxSize: 32768 }),
    zValidator("json", z.object({ rootId: z.string().min(1).max(128), noteId: z.string().min(1).max(128), configVersion: z.number().int().min(1), sourceHash: z.string().regex(/^[0-9a-f]{64}$/), sourceTitle: z.string().max(2000) })), async (c) => {
      c.header("Cache-Control", "no-store");
      const proof = parseHybragProof(c.req.header("Authorization"));
      if (proof.scheme !== "Integration") throw new AppError("hybrag_grant_required", "A restricted integration credential is required.", 403);
      const owner = await verifyHybragProof(c.env, proof.secret, proof.scheme);
      const input = c.req.valid("json");
      if (!owner.userId || !owner.workspaceId) throw new AppError("hybrag_grant_invalid", "Integration ownership is unavailable.", 403);
      const version = await requireHybragScope(c.env, { userId: owner.userId, workspaceId: owner.workspaceId }, input.rootId);
      if (version !== input.configVersion) throw new AppError("hybrag_source_changed", "Synchronization scope changed.", 409);
      const note = await c.env.storage.db.prepare(`${hybragNotebookScopeSQL} SELECT m.id FROM memos m JOIN memo_contents c ON c.memo_id=m.id WHERE m.id = ? AND m.workspace_id = ?
        AND c.content_hash=? AND COALESCE(m.title,'')=?
        AND m.is_deleted = 0 AND m.notebook_id IN (SELECT id FROM selected) AND ${HYBRAG_GRANT_CURRENT}
        AND EXISTS (SELECT 1 FROM hybrag_settings s WHERE s.user_id=? AND s.workspace_id=? AND s.enabled=1 AND s.version=?
          AND EXISTS (SELECT 1 FROM json_each(s.roots_json) WHERE value=?)
          AND NOT EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) p WHERE p.value IN (SELECT id FROM selected))
          AND NOT EXISTS (SELECT 1 FROM json_each(s.roots_json) r WHERE r.value<>? AND (r.value IN (SELECT id FROM selected) OR r.value IN (SELECT id FROM ancestors))))
        AND EXISTS (SELECT 1 FROM users u JOIN user_identities i ON i.user_id=u.id AND i.provider='vos' AND i.subject=?
          JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=?
          JOIN workspaces w ON w.id=wm.workspace_id AND w.is_personal=1 AND wm.role='owner'
            AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
          WHERE u.id=? AND u.is_disabled=0)`)
        .bind(input.rootId, owner.workspaceId, owner.workspaceId, input.rootId, owner.workspaceId, owner.workspaceId,
          input.noteId, owner.workspaceId,input.sourceHash,input.sourceTitle, ...hybragGrantParameters(owner), owner.userId,owner.workspaceId,input.configVersion,input.rootId,input.rootId,
          owner.subject,owner.workspaceId,owner.userId).first();
      if (!note) throw new AppError("hybrag_scope_invalid", "The note is outside the authorized scope.", 403);
      return c.json({ protocol: 1, authorized: true, subject: owner.subject, workspaceId: owner.workspaceId,
        configVersion: version, rootId: input.rootId, noteId: input.noteId });
    });
  app.post("/api/integrations/hybrag/redeem", bodyLimit({ maxSize: 32768 }),
    zValidator("json", z.object({ ticket: z.string().min(1).max(256) })), async (context) => {
      context.header("Cache-Control", "no-store");
      const proof = parseHybragProof(context.req.header("Authorization"));
      return context.json(await redeemHybragNoteTicket(context.env, context.req.valid("json").ticket, proof.secret, proof.scheme));
    });

  app.post("/api/v1/integrations/hybrag/sync-note", bodyLimit({ maxSize: 32768 }),
    zValidator("json", z.object({ accessToken: z.string().min(1).max(16384), rootId: z.string().min(1).max(128), memoId: z.string().min(1).max(128) })),
    async (context) => {
      context.header("Cache-Control", "no-store");
      const input = context.req.valid("json");
      const identity = await verifyHybragSessionIdentity(context, input.accessToken);
      const proof=await hybragExecutionProof(context.env,identity,input.accessToken);
      return context.json(await sendHybragNote(context.env, identity, proof.secret, input.rootId, input.memoId,proof.scheme), 202);
    });
};
