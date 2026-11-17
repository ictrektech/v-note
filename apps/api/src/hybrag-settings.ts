import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppContext, AppEnv } from "./api-context";
import { AppError } from "./app-error";
import { isVosMode } from "./vos-mode";
import { defaultHybragSchedule, hybragScheduleSchema } from "./hybrag-schedule";

export const requireHybragSettingsSession = async (context: AppContext) => {
  const auth = context.get("auth");
  if (!isVosMode(context.env) || auth?.kind !== "user" || !auth.actorId || !auth.sessionId || auth.mfaRestricted) {
    throw new AppError("hybrag_user_session_required", "A signed-in VOS user is required.", 403);
  }
  const member = await context.env.storage.db.prepare(`SELECT 1 AS ok FROM users u
    JOIN user_identities i ON i.user_id = u.id AND i.provider = 'vos'
    JOIN workspace_members m ON m.user_id = u.id
    JOIN workspaces w ON w.id = m.workspace_id AND w.is_personal = 1 AND m.role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
    WHERE u.id = ? AND u.is_disabled = 0 AND w.id = ?`).bind(auth.actorId, auth.workspaceId).first();
  if (!member) throw new AppError("hybrag_identity_unbound", "A personal VOS workspace is required.", 403);
  return { userId: auth.actorId, workspaceId: auth.workspaceId };
};

export const registerHybragSettingsRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/v1/integrations/hybrag/settings", async (context) => {
    context.header("Cache-Control", "no-store");
    const owner = await requireHybragSettingsSession(context);
    const [settings, notebooks, delivery] = await Promise.all([
      context.env.storage.db.prepare("SELECT enabled, roots_json, version, schedule_json,paused_roots_json FROM hybrag_settings WHERE user_id = ? AND workspace_id = ?")
        .bind(owner.userId, owner.workspaceId).first<{ enabled: number; roots_json: string; version: number; schedule_json: string;paused_roots_json:string }>(),
      context.env.storage.db.prepare("SELECT id, parent_id AS parentId, name FROM notebooks WHERE workspace_id = ? AND is_deleted = 0 ORDER BY name, id")
        .bind(owner.workspaceId).all<{ id: string; parentId: string | null; name: string }>(),
      context.env.storage.db.prepare("SELECT acknowledged_version FROM hybrag_control_delivery WHERE user_id = ? AND workspace_id = ?")
        .bind(owner.userId, owner.workspaceId).first<{ acknowledged_version: number }>(),
    ]);
    return context.json({ enabled: settings?.enabled === 1, roots: settings ? JSON.parse(settings.roots_json) : [], version: settings?.version ?? 0,
      schedule: settings ? JSON.parse(settings.schedule_json) : defaultHybragSchedule,
      pausedRoots:settings?JSON.parse(settings.paused_roots_json):[],
      capabilities:{rootPause:1},
      controlPending: !!settings && (delivery?.acknowledged_version ?? 0) < settings.version, notebooks: notebooks.results });
  });
  app.put("/api/v1/integrations/hybrag/settings", bodyLimit({ maxSize: 32768 }),
    zValidator("json", z.object({ enabled: z.boolean(), roots: z.array(z.string().min(1).max(128)).max(100), version: z.number().int().min(0), schedule: hybragScheduleSchema.optional(),pausedRoots:z.array(z.string().min(1).max(128)).max(100).optional() })), async (context) => {
      context.header("Cache-Control", "no-store");
      const owner = await requireHybragSettingsSession(context);
      const input = context.req.valid("json");
      const roots = new Set(input.roots);
      if (roots.size !== input.roots.length || (input.enabled && roots.size === 0)) throw new AppError("hybrag_invalid_roots", "Select distinct notebook roots.", 400);
      const previous=await context.env.storage.db.prepare("SELECT paused_roots_json FROM hybrag_settings WHERE user_id=? AND workspace_id=? AND version=?")
        .bind(owner.userId,owner.workspaceId,input.version).first<{paused_roots_json:string}>();
      const pausedRoots:string[]=input.pausedRoots??(previous?JSON.parse(previous.paused_roots_json).filter((id:string)=>roots.has(id)):[]);
      if(new Set(pausedRoots).size!==pausedRoots.length||pausedRoots.some(id=>!roots.has(id)))throw new AppError("hybrag_invalid_pause","Only selected roots can be paused.",400);
      const rows = await context.env.storage.db.prepare("SELECT id, parent_id FROM notebooks WHERE workspace_id = ? AND is_deleted = 0")
        .bind(owner.workspaceId).all<{ id: string; parent_id: string | null }>();
      const parents = new Map(rows.results.map((row) => [row.id, row.parent_id]));
      for (const root of roots) {
        if (!parents.has(root)) throw new AppError("hybrag_invalid_roots", "A selected notebook no longer exists.", 400);
        const seen = new Set([root]);
        let parent = parents.get(root);
        while (parent && parents.has(parent)) {
          if (seen.has(parent) || roots.has(parent)) throw new AppError("hybrag_overlapping_roots", "Notebook roots cannot overlap.", 400);
          seen.add(parent); parent = parents.get(parent);
        }
      }
      const result = input.version === 0
        ? await context.env.storage.db.prepare("INSERT INTO hybrag_settings (user_id,workspace_id,enabled,roots_json,version,schedule_json,paused_roots_json) VALUES (?,?,?,?,1,?,?) ON CONFLICT DO NOTHING RETURNING version")
          .bind(owner.userId, owner.workspaceId, input.enabled ? 1 : 0, JSON.stringify(input.roots),JSON.stringify(input.schedule??defaultHybragSchedule),JSON.stringify(pausedRoots)).first<{ version: number }>()
        : await context.env.storage.db.prepare("UPDATE hybrag_settings SET enabled = ?, roots_json = ?, schedule_json=COALESCE(?,schedule_json),paused_roots_json=?, version = version + 1 WHERE user_id = ? AND workspace_id = ? AND version = ? RETURNING version")
          .bind(input.enabled ? 1 : 0, JSON.stringify(input.roots),input.schedule?JSON.stringify(input.schedule):null,JSON.stringify(pausedRoots), owner.userId, owner.workspaceId, input.version).first<{ version: number }>();
      if (!result) throw new AppError("hybrag_settings_conflict", "Settings changed in another session. Reload and retry.", 409);
      return context.json({ version: result.version });
    });
};
