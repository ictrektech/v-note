import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { sha256 } from "./hash-utils";
import { parseHybragProof, verifyHybragProof, HYBRAG_GRANT_CURRENT, hybragGrantParameters, type HybragProof } from "./hybrag-delegation-proof";
import { hybragNotebookScopeSQL, requireHybragScope, mintHybragNoteTicket, redeemHybragNoteTicket } from "./hybrag-note";
import { hybragScheduleSchema } from "./hybrag-schedule";

type Owner = HybragProof & { userId: string; workspaceId: string; grantId: string; grantVersion: number };
type Scope = { version: number; graph_revision: number; sync_identity: string; server_cursor: number; pruned_through: number; root_name: string; root_missing: number };
type SourceNote = { id: string; notebook_id: string; title: string; source_hash: string; updated_at: string };
const rootInput = z.object({ rootId: z.string().min(1).max(128), configVersion: z.number().int().min(1) });
const pageInput = rootInput.extend({ syncIdentity: z.string().max(255).optional(), graphRevision: z.number().int().min(0).optional(),
  startCursor:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),startCursorStamp:z.string().max(64).optional(),
  afterNotebookId: z.string().max(128).default(""), afterNoteId: z.string().max(128).default(""), limit: z.number().int().min(1).max(50).default(50) });
const changeInput = rootInput.extend({ syncIdentity: z.string().min(1).max(255), graphRevision: z.number().int().min(0),
  cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), cursorStamp: z.string().max(64).default(""), limit: z.number().int().min(1).max(100).default(100) });

const sourceOwner = async (env: Bindings, header: string | undefined): Promise<Owner> => {
  const proof = parseHybragProof(header);
  if (proof.scheme !== "Integration") throw new AppError("hybrag_grant_required", "A restricted integration credential is required.", 403);
  const owner = await verifyHybragProof(env,proof.secret,proof.scheme);
  if (!owner.userId || !owner.workspaceId || !owner.grantId || !owner.grantVersion) throw new AppError("hybrag_grant_invalid", "Integration ownership is unavailable.", 403);
  return owner as Owner;
};

// Parameters are constant within a request, so this guard is evaluated as a
// scalar subquery. It does not traverse notebooks or read memo bodies.
const sourceGuard = `EXISTS (SELECT 1 FROM hybrag_settings s
  JOIN users u ON u.id=s.user_id AND u.is_disabled=0
  JOIN user_identities i ON i.user_id=u.id AND i.provider='vos' AND i.subject=?
  JOIN workspace_members wm ON wm.user_id=u.id AND wm.workspace_id=s.workspace_id AND wm.role='owner'
  JOIN workspaces w ON w.id=wm.workspace_id AND w.is_personal=1
  JOIN hybrag_control_delivery d ON d.user_id=s.user_id AND d.workspace_id=s.workspace_id AND d.acknowledged_version=s.version
  WHERE s.user_id=? AND s.workspace_id=? AND s.version=? AND s.enabled=1
    AND EXISTS (SELECT 1 FROM json_each(s.roots_json) WHERE value=?)
    AND NOT EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) WHERE value=?)
    AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
    AND COALESCE((SELECT graph_revision FROM hybrag_workspace_state WHERE workspace_id=w.id),0)=?
    AND COALESCE((SELECT pruned_through FROM hybrag_workspace_state WHERE workspace_id=w.id),0)=? AND w.created_at=?)
  AND ${HYBRAG_GRANT_CURRENT}`;
const guardParameters = (owner: Owner,root: string,scope: Scope) => [owner.subject,owner.userId,owner.workspaceId,scope.version,root,root,
  scope.graph_revision,scope.pruned_through,scope.sync_identity,...hybragGrantParameters(owner)];

const sourceScope = async (env: Bindings,owner: Owner,root: string,version: number): Promise<Scope> => {
  const state=await env.storage.db.prepare(`SELECT s.version,w.created_at AS sync_identity,COALESCE(g.graph_revision,0) AS graph_revision,
    COALESCE(g.pruned_through,0) AS pruned_through,CASE WHEN n.is_deleted=0 THEN substr(n.name,1,255) ELSE '' END AS root_name,
    CASE WHEN n.id IS NULL OR n.is_deleted<>0 THEN 1 ELSE 0 END AS root_missing,
    MAX(COALESCE(g.pruned_through,0),COALESCE((SELECT MAX(id) FROM mobile_sync_changes WHERE workspace_id=s.workspace_id),0)) AS server_cursor
    FROM hybrag_settings s JOIN workspaces w ON w.id=s.workspace_id
    LEFT JOIN notebooks n ON n.id=? AND n.workspace_id=s.workspace_id
    LEFT JOIN hybrag_workspace_state g ON g.workspace_id=s.workspace_id
    WHERE s.user_id=? AND s.workspace_id=? AND s.version=? AND s.enabled=1
      AND EXISTS (SELECT 1 FROM json_each(s.roots_json) WHERE value=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) WHERE value=?)`)
    .bind(root,owner.userId,owner.workspaceId,version,root,root).first<Scope>();
  if(!state) throw new AppError("hybrag_scope_denied","The notebook scope is unavailable.",403);
  const cached=await env.storage.db.prepare(`SELECT config_version,graph_revision,sync_identity FROM hybrag_source_scope_versions
    WHERE user_id=? AND workspace_id=? AND root_id=?`).bind(owner.userId,owner.workspaceId,root)
    .first<{config_version:number;graph_revision:number;sync_identity:string}>();
  if(cached?.config_version===state.version&&cached.graph_revision===state.graph_revision&&cached.sync_identity===state.sync_identity) return state;
  // Rebuild only when configuration, hierarchy or source identity changes.
  // Pagination reuses the materialized scope instead of walking the full tree.
  if(!state.root_missing&&await requireHybragScope(env,owner,root)!==version) throw new AppError("hybrag_source_changed","Notebook scope changed.",409);
  // A selected root that disappeared authorizes an empty, guarded metadata
  // scope only. It cannot export bodies or expose a notebook in another space.
  if(state.root_missing&&!await env.storage.db.prepare(`SELECT 1 AS ok WHERE ${sourceGuard}`).bind(...guardParameters(owner,root,state)).first()) {
    throw new AppError("hybrag_source_changed","Notebook retirement authorization changed.",409);
  }
  const key=[owner.userId,owner.workspaceId,root];
  await env.storage.db.batch([
    env.storage.db.prepare(`DELETE FROM hybrag_source_scope_versions WHERE user_id=? AND workspace_id=? AND root_id=? AND ${sourceGuard}`)
      .bind(...key,...guardParameters(owner,root,state)),
    env.storage.db.prepare(`DELETE FROM hybrag_source_scopes WHERE user_id=? AND workspace_id=? AND root_id=? AND ${sourceGuard}`)
      .bind(...key,...guardParameters(owner,root,state)),
    env.storage.db.prepare(`${hybragNotebookScopeSQL} INSERT INTO hybrag_source_scopes(user_id,workspace_id,root_id,notebook_id)
      SELECT ?,?,?,id FROM selected WHERE ${sourceGuard}`)
      .bind(root,owner.workspaceId,owner.workspaceId,root,owner.workspaceId,owner.workspaceId,...key,...guardParameters(owner,root,state)),
    env.storage.db.prepare(`INSERT INTO hybrag_source_scope_versions(user_id,workspace_id,root_id,config_version,graph_revision,sync_identity)
      SELECT ?,?,?,?,?,? WHERE ${sourceGuard}`)
      .bind(...key,state.version,state.graph_revision,state.sync_identity,...guardParameters(owner,root,state)),
  ]);
  const built=await env.storage.db.prepare(`SELECT 1 AS ok FROM hybrag_source_scope_versions WHERE user_id=? AND workspace_id=? AND root_id=?
    AND config_version=? AND graph_revision=? AND sync_identity=?`).bind(...key,state.version,state.graph_revision,state.sync_identity).first();
  if(!built) throw new AppError("hybrag_source_changed","Notebook scope changed during the request.",409);
  return state;
};

const rememberNotes = async (env: Bindings,owner: Owner,root: string,scope: Scope,ids: string[]) => {
  await env.storage.db.prepare(`INSERT INTO hybrag_source_members(user_id,workspace_id,root_id,memo_id)
    SELECT ?,?,?,value FROM json_each(?) WHERE ${sourceGuard} ON CONFLICT DO NOTHING`)
    .bind(owner.userId,owner.workspaceId,root,JSON.stringify(ids),...guardParameters(owner,root,scope)).run();
  const current=await env.storage.db.prepare(`SELECT 1 AS ok WHERE ${sourceGuard}`).bind(...guardParameters(owner,root,scope)).first();
  if(!current) throw new AppError("hybrag_source_changed","Authorization or notebook hierarchy changed.",409);
};

const cursorStamp = async (env: Bindings,owner: Owner,cursor: number,scope: Scope) => {
  if(cursor===0) return "";
  const event=await env.storage.db.prepare(`SELECT id,entity_type,entity_id,operation,changed_at FROM mobile_sync_changes WHERE workspace_id=? AND id=?`)
    .bind(owner.workspaceId,cursor).first<{id:number;entity_type:string;entity_id:string;operation:string;changed_at:string}>();
  if(!event) {
    if(cursor===scope.pruned_through) return sha256(JSON.stringify([owner.workspaceId,scope.sync_identity,"pruned",cursor]));
    throw new AppError("hybrag_cursor_reset","The source change history is unavailable; rebuild the snapshot.",409);
  }
  return sha256(JSON.stringify([owner.workspaceId,event.id,event.entity_type,event.entity_id,event.operation,event.changed_at]));
};

export const registerHybragSourceRoutes = (app: Hono<AppEnv>) => {
  // A small configuration lookup: no hierarchy traversal, note scan or body.
  app.post("/api/integrations/hybrag/plan",bodyLimit({maxSize:8192}),zValidator("json",rootInput),async(c)=>{
    c.header("Cache-Control","no-store");
    const input=c.req.valid("json"),owner=await sourceOwner(c.env,c.req.header("Authorization"));
    const row=await c.env.storage.db.prepare(`SELECT s.schedule_json,CASE WHEN n.is_deleted=0 THEN substr(n.name,1,255) ELSE '' END AS root_name,
      CASE WHEN n.id IS NULL OR n.is_deleted<>0 THEN 1 ELSE 0 END AS root_missing,EXISTS (SELECT 1 FROM json_each(s.paused_roots_json) WHERE value=?) AS paused FROM hybrag_settings s
      JOIN hybrag_control_delivery d ON d.user_id=s.user_id AND d.workspace_id=s.workspace_id AND d.acknowledged_version=s.version
      LEFT JOIN notebooks n ON n.workspace_id=s.workspace_id AND n.id=?
      WHERE s.user_id=? AND s.workspace_id=? AND s.version=? AND s.enabled=1
      AND EXISTS (SELECT 1 FROM json_each(s.roots_json) WHERE value=?) AND ${HYBRAG_GRANT_CURRENT}`)
      .bind(input.rootId,input.rootId,owner.userId,owner.workspaceId,input.configVersion,input.rootId,...hybragGrantParameters(owner)).first<{schedule_json:string;paused:number;root_name:string;root_missing:number}>();
    if(!row) throw new AppError("hybrag_scope_denied","The current synchronization plan is unavailable.",403);
    return c.json({protocol:1,subject:owner.subject,workspaceId:owner.workspaceId,rootId:input.rootId,configVersion:input.configVersion,
      schedule:hybragScheduleSchema.parse(JSON.parse(row.schedule_json)),paused:row.paused===1,rootMissing:row.root_missing===1,...(!row.root_missing?{rootName:row.root_name}:{})});
  });
  app.post("/api/integrations/hybrag/snapshot",bodyLimit({maxSize:8192}),zValidator("json",pageInput),async(c)=>{
    c.header("Cache-Control","no-store");
    const input=c.req.valid("json"),owner=await sourceOwner(c.env,c.req.header("Authorization"));
    const scope=await sourceScope(c.env,owner,input.rootId,input.configVersion);
    if((input.syncIdentity&&input.syncIdentity!==scope.sync_identity)||(input.graphRevision!==undefined&&input.graphRevision!==scope.graph_revision)) {
      throw new AppError("hybrag_cursor_reset","Source identity or notebook hierarchy changed; rebuild the snapshot.",409);
    }
    if(Boolean(input.afterNotebookId)!==Boolean(input.afterNoteId)||((input.afterNotebookId||input.afterNoteId)&&
      (input.startCursor===undefined||input.startCursorStamp===undefined||!input.syncIdentity||input.graphRevision===undefined))) {
      throw new AppError("hybrag_snapshot_cursor_required","Continue with the identity, hierarchy version and change cursor from the first page.",400);
    }
    const startCursor=input.startCursor??scope.server_cursor;
    const stamp=await cursorStamp(c.env,owner,startCursor,scope);
    if(startCursor>scope.server_cursor||startCursor<scope.pruned_through||(input.startCursorStamp!==undefined&&input.startCursorStamp!==stamp)) {
      throw new AppError("hybrag_cursor_reset","The initial snapshot cursor is no longer valid.",409);
    }
    // A composite notebook/note bookmark follows the covering index. It avoids
    // repeatedly sorting all notes or scanning unrelated workspace notes.
    const rows=await c.env.storage.db.prepare(`SELECT m.id,m.notebook_id,substr(COALESCE(m.title,''),1,2001) AS title,
      substr(COALESCE(mc.content_hash,''),1,65) AS source_hash,m.updated_at
      FROM hybrag_source_scopes nb CROSS JOIN memos m INDEXED BY hybrag_snapshot_note_cursor
        ON m.workspace_id=nb.workspace_id AND m.notebook_id=nb.notebook_id AND m.is_deleted=0
      LEFT JOIN memo_contents mc ON mc.memo_id=m.id
      WHERE nb.user_id=? AND nb.workspace_id=? AND nb.root_id=? AND nb.notebook_id>=?
        AND m.id>CASE WHEN nb.notebook_id=? THEN ? ELSE '' END AND ${sourceGuard}
      ORDER BY nb.notebook_id,m.id LIMIT ?`)
      .bind(owner.userId,owner.workspaceId,input.rootId,input.afterNotebookId,input.afterNotebookId,input.afterNoteId,
        ...guardParameters(owner,input.rootId,scope),input.limit+1).all<SourceNote>();
    const page=rows.results.slice(0,input.limit);
    await rememberNotes(c.env,owner,input.rootId,scope,page.map(row=>row.id));
    return c.json({protocol:1,subject:owner.subject,workspaceId:owner.workspaceId,rootId:input.rootId,configVersion:scope.version,
      syncIdentity:scope.sync_identity,graphRevision:scope.graph_revision,rootName:scope.root_name,
      snapshotCursor:startCursor,snapshotCursorStamp:stamp,
      hasMore:rows.results.length>input.limit,afterNotebookId:page.at(-1)?.notebook_id??input.afterNotebookId,
      afterNoteId:page.at(-1)?.id??input.afterNoteId,notes:page.map(row=>({noteId:row.id,notebookId:row.notebook_id,title:row.title,sourceHash:row.source_hash,updatedAt:row.updated_at}))});
  });

  app.post("/api/integrations/hybrag/changes",bodyLimit({maxSize:8192}),zValidator("json",changeInput),async(c)=>{
    c.header("Cache-Control","no-store");
    const input=c.req.valid("json"),owner=await sourceOwner(c.env,c.req.header("Authorization"));
    const scope=await sourceScope(c.env,owner,input.rootId,input.configVersion);
    if(input.syncIdentity!==scope.sync_identity||input.cursor>scope.server_cursor||input.cursor<scope.pruned_through||
      await cursorStamp(c.env,owner,input.cursor,scope)!==input.cursorStamp) throw new AppError("hybrag_cursor_reset","Source history changed; rebuild the snapshot.",409);
    const rows=await c.env.storage.db.prepare(`WITH page AS (
      SELECT id,entity_type,entity_id FROM mobile_sync_changes WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?
    ),bounded AS (SELECT * FROM page ORDER BY id LIMIT ?),effective AS (
      SELECT entity_id,MAX(id) AS sequence FROM bounded WHERE entity_type='memo' GROUP BY entity_id
    ),allowed AS (
      SELECT m.id,m.notebook_id,substr(COALESCE(m.title,''),1,2001) AS title,substr(COALESCE(mc.content_hash,''),1,65) AS source_hash,m.updated_at
      FROM memos m JOIN hybrag_source_scopes nb ON nb.notebook_id=m.notebook_id AND nb.workspace_id=m.workspace_id
      LEFT JOIN memo_contents mc ON mc.memo_id=m.id
      WHERE nb.user_id=? AND nb.workspace_id=? AND nb.root_id=? AND m.is_deleted=0
        AND m.id IN (SELECT entity_id FROM effective)
    ),meta AS (SELECT COALESCE(MAX(id),?) AS cursor,(SELECT COUNT(*) FROM page)>? AS has_more FROM bounded)
    SELECT meta.cursor,meta.has_more,e.sequence,CASE WHEN a.id IS NOT NULL OR known.memo_id IS NOT NULL THEN e.entity_id END AS note_id,
      a.id AS active_id,a.notebook_id,a.title,a.source_hash,a.updated_at FROM meta
    LEFT JOIN effective e ON 1=1
    LEFT JOIN allowed a ON a.id=e.entity_id
    LEFT JOIN hybrag_source_members known ON known.memo_id=e.entity_id AND known.user_id=? AND known.workspace_id=? AND known.root_id=?
    WHERE ${sourceGuard} ORDER BY e.sequence`)
      .bind(owner.workspaceId,input.cursor,input.limit+1,input.limit,owner.userId,owner.workspaceId,input.rootId,input.cursor,input.limit,
        owner.userId,owner.workspaceId,input.rootId,...guardParameters(owner,input.rootId,scope))
      .all<{cursor:number;has_more:number;sequence:number|null;note_id:string|null;active_id:string|null;notebook_id:string|null;title:string|null;source_hash:string|null;updated_at:string|null}>();
    if(!rows.results.length) throw new AppError("hybrag_source_changed","Authorization changed.",409);
    const events=rows.results.filter(row=>row.note_id!==null).map(row=>({sequence:row.sequence!,noteId:row.note_id!,
      operation:row.active_id?"upsert" as const:"delete" as const,...(row.active_id?{notebookId:row.notebook_id,title:row.title,sourceHash:row.source_hash,updatedAt:row.updated_at}:{})}));
    await rememberNotes(c.env,owner,input.rootId,scope,events.filter(event=>event.operation==="upsert").map(event=>event.noteId));
    const cursor=rows.results[0].cursor;
    return c.json({protocol:1,subject:owner.subject,workspaceId:owner.workspaceId,rootId:input.rootId,configVersion:scope.version,
      syncIdentity:scope.sync_identity,graphRevision:scope.graph_revision,rescan:input.graphRevision!==scope.graph_revision,
      rootName:scope.root_name,
      cursor,cursorStamp:await cursorStamp(c.env,owner,cursor,scope),hasMore:!!rows.results[0].has_more,events});
  });

  app.post("/api/integrations/hybrag/export-note",bodyLimit({maxSize:8192}),zValidator("json",rootInput.extend({noteId:z.string().min(1).max(128)})),async(c)=>{
    c.header("Cache-Control","no-store");
    const input=c.req.valid("json"),proof=parseHybragProof(c.req.header("Authorization")),owner=await sourceOwner(c.env,c.req.header("Authorization"));
    if(await requireHybragScope(c.env,owner,input.rootId)!==input.configVersion) throw new AppError("hybrag_source_changed","Synchronization scope changed.",409);
    const ticket=await mintHybragNoteTicket(c.env,owner,input.rootId,input.noteId);
    try {return c.json(await redeemHybragNoteTicket(c.env,ticket.token,proof.secret,"Integration"));}
    finally {await c.env.storage.db.prepare("DELETE FROM hybrag_note_tickets WHERE id=? AND user_id=?").bind(ticket.id,owner.userId).run();}
  });
};
