import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "./api-context";
import { AppError } from "./app-error";
import { randomToken } from "./auth-crypto";
import { isoNow } from "./entity-utils";
import { verifyHybragSessionIdentity } from "./hybrag-identity";
import { queryHybragStatus, requireHybragScope, sendHybragNote } from "./hybrag-note";
import { requireHybragSettingsSession } from "./hybrag-settings";
import { deliverHybragControl } from "./hybrag-control";
import { hybragExecutionProof } from "./hybrag-delegation-store";

type Run = { config_version: number; cursor: string; pending_note_id: string; pending_attempt: string; state: string; completed: number; skipped: number; failed: number; last_error: string; updated_at: string };
const input = z.object({ accessToken: z.string().min(1).max(16384), rootId: z.string().min(1).max(128) });

export const registerHybragManualRoutes = (app: Hono<AppEnv>) => {
  app.post("/api/v1/integrations/hybrag/background-status",bodyLimit({maxSize:32768}),zValidator("json",z.object({accessToken:z.string().min(1).max(16384)})),async(c)=>{
    c.header("Cache-Control","no-store");
    const proof=c.req.valid("json").accessToken,owner=await verifyHybragSessionIdentity(c,proof);
    const row=await c.env.storage.db.prepare("SELECT roots_json FROM hybrag_settings WHERE user_id=? AND workspace_id=?")
      .bind(owner.userId,owner.workspaceId).first<{roots_json:string}>();
    const result=await queryHybragStatus(c.env,proof,"","","Bearer",{workspaceId:owner.workspaceId,roots:row?JSON.parse(row.roots_json):[]});
    return c.json({runs:result.syncRuns});
  });
  app.post("/api/v1/integrations/hybrag/discover", bodyLimit({ maxSize: 32768 }), zValidator("json", z.object({ accessToken: z.string().min(1).max(16384) })), async (c) => {
    c.header("Cache-Control", "no-store");
    const proof = c.req.valid("json").accessToken;
    await verifyHybragSessionIdentity(c, proof);
    return c.json(await queryHybragStatus(c.env, proof));
  });
  app.get("/api/v1/integrations/hybrag/runs", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = await requireHybragSettingsSession(c);
    const runs = await c.env.storage.db.prepare(`SELECT root_id AS rootId, config_version AS configVersion, state, completed, skipped, failed,
      skipped_type AS skippedType, skipped_resource AS skippedResource, skipped_size AS skippedSize, last_error AS lastError, updated_at AS updatedAt
      FROM hybrag_manual_runs WHERE user_id = ? AND workspace_id = ?`).bind(owner.userId, owner.workspaceId).all();
    return c.json({ runs: runs.results });
  });
  app.post("/api/v1/integrations/hybrag/start", bodyLimit({ maxSize: 32768 }), zValidator("json", input), async (c) => {
    c.header("Cache-Control", "no-store");
    const { accessToken, rootId } = c.req.valid("json");
    const owner = await verifyHybragSessionIdentity(c, accessToken);
    const proof=await hybragExecutionProof(c.env,owner,accessToken);
    await queryHybragStatus(c.env, proof.secret,"","",proof.scheme);
    const control = await deliverHybragControl(c.env, owner, proof.secret,proof.scheme);
    if (control.pending) throw new AppError("hybrag_control_pending", "The current authorization has not reached HybRAG.", 503);
    const version = await requireHybragScope(c.env, owner, rootId);
    if (control.version !== version) throw new AppError("hybrag_control_pending", "The current authorization has changed.", 503);
    const now = isoNow();
    const row = await c.env.storage.db.prepare(`INSERT INTO hybrag_manual_runs (user_id, workspace_id, root_id, config_version, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, workspace_id, root_id) DO UPDATE SET config_version = excluded.config_version,
      cursor = '', pending_note_id = '', pending_attempt = '', state = 'running', completed = 0, skipped = 0, failed = 0, last_error = '',
      skipped_type = 0, skipped_resource = 0, skipped_size = 0,
      lock_token = '', lock_until = '', updated_at = excluded.updated_at
      WHERE hybrag_manual_runs.lock_until <= ? AND (hybrag_manual_runs.state <> 'running' OR hybrag_manual_runs.config_version <> excluded.config_version)
      RETURNING root_id`).bind(owner.userId, owner.workspaceId, rootId, version, now, now).first();
    if (!row) {
      const existing = await c.env.storage.db.prepare(`SELECT state, config_version FROM hybrag_manual_runs
        WHERE user_id = ? AND workspace_id = ? AND root_id = ?`).bind(owner.userId, owner.workspaceId, rootId).first<Run>();
      if (existing?.state === "running" && existing.config_version === version) return c.json({ started: true, resumed: true });
      throw new AppError("hybrag_run_busy", "A synchronization request is already running.", 409);
    }
    return c.json({ started: true, resumed: false });
  });
  app.post("/api/v1/integrations/hybrag/step", bodyLimit({ maxSize: 32768 }), zValidator("json", input), async (c) => {
    c.header("Cache-Control", "no-store");
    const { accessToken, rootId } = c.req.valid("json");
    const owner = await verifyHybragSessionIdentity(c, accessToken);
    const proof=await hybragExecutionProof(c.env,owner,accessToken);
    const version = await requireHybragScope(c.env, owner, rootId);
    const token = randomToken(16), now = isoNow();
    const lock = await c.env.storage.db.prepare(`UPDATE hybrag_manual_runs SET lock_token = ?, lock_until = ?
      WHERE user_id = ? AND workspace_id = ? AND root_id = ? AND config_version = ? AND state = 'running' AND lock_until <= ? RETURNING *`)
      .bind(token, new Date(Date.now() + 60000).toISOString(), owner.userId, owner.workspaceId, rootId, version, now).first<Run>();
    if (!lock) {
      const existing = await c.env.storage.db.prepare(`SELECT state, config_version, lock_until FROM hybrag_manual_runs
        WHERE user_id = ? AND workspace_id = ? AND root_id = ?`).bind(owner.userId, owner.workspaceId, rootId)
        .first<Run & { lock_until: string }>();
      if (existing?.state === "running" && existing.config_version === version && existing.lock_until > now) {
        throw new AppError("hybrag_run_busy", "A synchronization request is already running.", 409);
      }
      throw new AppError("hybrag_run_unavailable", "The run is stopped or changed. Reload its status.", 409);
    }
    const update = async (sql: string, ...args: (string | number)[]) => c.env.storage.db.prepare(`UPDATE hybrag_manual_runs SET ${sql}, updated_at = ?
      WHERE user_id = ? AND workspace_id = ? AND root_id = ? AND lock_token = ? AND config_version = ?
        AND EXISTS (SELECT 1 FROM hybrag_settings s, json_each(s.roots_json) r
          WHERE s.user_id = hybrag_manual_runs.user_id AND s.workspace_id = hybrag_manual_runs.workspace_id
            AND s.enabled = 1 AND s.version = hybrag_manual_runs.config_version AND r.value = hybrag_manual_runs.root_id
            AND NOT EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) p WHERE p.value=r.value))`)
      .bind(...args, isoNow(), owner.userId, owner.workspaceId, rootId, token, version).run();
    try {
      if (lock.pending_note_id) {
        // A process may have died after sending the request but before receiving
        // its result. Status can describe an older generation of the same note,
        // so it cannot resolve this ambiguity without an attempt identifier.
        if (lock.last_error === "hybrag_delivery_uncertain" || !lock.pending_attempt) return c.json({ state: "recovery_required" });
        const status = await queryHybragStatus(c.env, proof.secret, rootId, lock.pending_note_id,proof.scheme);
        if (status.result?.attempt !== lock.pending_attempt) {
          await update("last_error = ?", "hybrag_recovery_required");
          return c.json({ state: "recovery_required" });
        }
        const state = status.result?.state;
        if (state === "completed") await update("cursor = ?, pending_note_id = '', pending_attempt = '', completed = completed + 1, last_error = ''", lock.pending_note_id);
        else if (state === "recovery_required" || state === "not_imported") await update("last_error = ?", "hybrag_recovery_required");
        else if (state === "failed" || state === "cancelled") await update("cursor = ?, pending_note_id = '', pending_attempt = '', failed = failed + 1, last_error = ?", lock.pending_note_id, "hybrag_index_failed");
        return c.json({ state: state === "completed" ? "running" : state === "not_imported" ? "recovery_required" : state });
      }
      const note = await c.env.storage.db.prepare(`WITH RECURSIVE scope(id) AS (
        SELECT id FROM notebooks WHERE id = ? AND workspace_id = ? AND is_deleted = 0
        UNION SELECT n.id FROM notebooks n JOIN scope s ON n.parent_id = s.id WHERE n.workspace_id = ? AND n.is_deleted = 0)
        SELECT m.id FROM memos m WHERE m.workspace_id = ? AND m.is_deleted = 0 AND m.id > ? AND m.notebook_id IN (SELECT id FROM scope)
        ORDER BY m.id LIMIT 1`).bind(rootId, owner.workspaceId, owner.workspaceId, owner.workspaceId, lock.cursor).first<{ id: string }>();
      if (!note) { await update("state = 'completed', last_error = ''"); return c.json({ state: "completed" }); }
      const reserved = await c.env.storage.db.prepare(`UPDATE hybrag_manual_runs SET pending_note_id = ?, pending_attempt = '', last_error = 'hybrag_delivery_uncertain', updated_at = ?
        WHERE user_id = ? AND workspace_id = ? AND root_id = ? AND lock_token = ? AND config_version = ? AND state = 'running'
          AND EXISTS (SELECT 1 FROM hybrag_settings s, json_each(s.roots_json) r
            WHERE s.user_id = hybrag_manual_runs.user_id AND s.workspace_id = hybrag_manual_runs.workspace_id
              AND s.enabled = 1 AND s.version = hybrag_manual_runs.config_version AND r.value = hybrag_manual_runs.root_id
              AND NOT EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) p WHERE p.value=r.value))
        RETURNING root_id`).bind(note.id, isoNow(), owner.userId, owner.workspaceId, rootId, token, version).first();
      if (!reserved) throw new AppError("hybrag_run_unavailable", "The run is stopped or changed. Reload its status.", 409);
      try {
        const result = await sendHybragNote(c.env, owner, proof.secret, rootId, note.id,proof.scheme);
        if (result.state === "completed") await update("cursor = ?, pending_note_id = '', pending_attempt = '', completed = completed + 1, last_error = ''", note.id);
        else if (result.attempt) await update("pending_note_id = ?, pending_attempt = ?, last_error = ''", note.id, result.attempt);
      } catch (error) {
        if (error instanceof AppError && error.code === "hybrag_embedding_unavailable") {
          // Only the versioned, explicit pre-admission refusal is safe to
          // retry. Generic 422s and lost responses retain the attempt fence.
          await update("pending_note_id = '', pending_attempt = '', last_error = ?", "hybrag_model_or_storage");
        }
        if (error instanceof AppError && ["hybrag_note_type_unsupported", "hybrag_note_resources_unsupported", "hybrag_note_size_unsupported"].includes(error.code)) {
          const column = error.code === "hybrag_note_type_unsupported" ? "skipped_type" : error.code === "hybrag_note_resources_unsupported" ? "skipped_resource" : "skipped_size";
          await update(`cursor = ?, pending_note_id = '', pending_attempt = '', skipped = skipped + 1, ${column} = ${column} + 1, last_error = ''`, note.id);
        } else throw error;
      }
      return c.json({ state: "running" });
    } catch (error) {
      const code = error instanceof AppError ? error.code : "hybrag_sync_failed";
      // Preserve the uncertainty marker after reservation, including on
      // timeouts and lost responses. An expired lease cannot clear it.
      await update("last_error = CASE WHEN last_error = 'hybrag_delivery_uncertain' THEN last_error ELSE ? END", code === "hybrag_busy" ? "" : code);
      throw error;
    } finally {
      await c.env.storage.db.prepare(`UPDATE hybrag_manual_runs SET lock_token = '', lock_until = ''
        WHERE user_id = ? AND workspace_id = ? AND root_id = ? AND lock_token = ?`).bind(owner.userId, owner.workspaceId, rootId, token).run();
    }
  });
};
