import { resourceLinkToMarkdown } from "@edgeever/shared";
import { bodyLimit } from "hono/body-limit";
import type { Hono } from "hono";
import type { AppContext, AppEnv, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { sha256Bytes } from "./hash-utils";
import { verifyHybragSessionIdentity } from "./hybrag-identity";
import { hybragTarget } from "./hybrag-note";
import { createMemoRecord } from "./memo-service";
import { notebookExists } from "./notebook-service";
import { resolveObjectStorage } from "./object-storage";
import type { PreparedStatementAdapter } from "./storage-contract";
import { isVosMode } from "./vos-mode";

const maxUpload = 100 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const route = "/api/v1/integrations/hybrag/document-imports";
const types = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Job = {
  id: string;
  user_id: string;
  workspace_id: string;
  notebook_id: string;
  filename: string;
  mime_type: string;
  source_hash: string;
  remote_id: string;
  remote_token: string;
  remote_confirmed?: number;
  state: "queued" | "processing" | "completed" | "failed";
  error_code: string | null;
  memo_id: string | null;
  pages_done?: number | null;
  pages_total?: number | null;
  created_at: string;
  updated_at: string;
};

const now = () => new Date().toISOString();
const sourceKey = (job: Pick<Job, "workspace_id" | "id">) => `document-imports/${job.workspace_id}/${job.id}/source`;
const remoteURL = (env: Bindings, job: Job) => `${hybragTarget(env)}/api/v1/vnote/document-imports/${job.remote_id}`;
const makeToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, "0")).join("");

const view = (job: Job) => ({
  id: job.id, notebookId: job.notebook_id, filename: job.filename, state: job.state,
  errorCode: job.error_code, memoId: job.memo_id, updatedAt: job.updated_at,
  pagesDone: job.pages_done ?? null, pagesTotal: job.pages_total ?? null,
});

const session = (c: AppContext) => {
  const auth = c.get("auth");
  if (!isVosMode(c.env) || auth?.kind !== "user" || !auth.actorId || !auth.sessionId || auth.mfaRestricted) {
    throw new AppError("document_import_session_required", "A VOS user session is required.", 403);
  }
  return { userId: auth.actorId, workspaceId: auth.workspaceId };
};

const findJob = (env: Bindings, id: string, userId: string, workspaceId: string) =>
  env.storage.db.prepare("SELECT * FROM document_imports WHERE id=? AND user_id=? AND workspace_id=?")
    .bind(id, userId, workspaceId).first<Job>();

const setState = (env: Bindings, job: Job, state: Job["state"], error?: string) =>
  env.storage.db.prepare(`UPDATE document_imports SET state=?,error_code=?,updated_at=?
    WHERE id=? AND remote_id=? AND state IN ('queued','processing')`)
    .bind(state, error ?? null, now(), job.id, job.remote_id).run();

const submit = async (env: Bindings, job: Job, proof: string) => {
  try {
    const source = await env.storage.resources.get(sourceKey(job));
    if (!source) {
      await setState(env, job, "failed", "document_source_missing");
      return;
    }
    const response = await fetch(remoteURL(env, job), {
      method: "PUT", redirect: "error", signal: AbortSignal.timeout(90_000),
      headers: {
        Authorization: `Bearer ${proof}`,
        "X-Document-Token": job.remote_token,
        "X-Document-Filename": encodeURIComponent(job.filename),
        "Content-Type": job.mime_type,
        "Content-Length": String(source.size),
      },
      body: await new Response(source.body).arrayBuffer(),
    });
    if (response.status === 202) {
      await env.storage.db.prepare("UPDATE document_imports SET remote_confirmed=1 WHERE id=? AND remote_id=?")
        .bind(job.id, job.remote_id).run();
      return;
    }
    const code = response.status === 404 ? "document_service_upgrade_required"
      : response.status === 409 ? "document_identity_binding_required"
      : response.status === 413 ? "document_too_large"
      : response.status === 401 || response.status === 403 ? "document_service_access_denied"
      : "document_service_unavailable";
    await setState(env, job, "failed", code);
  } catch {
    // A lost HTTP response may have followed a successful enqueue.
    // The worker can determine the outcome using the per-job token.
  }
};

export const registerDocumentImportRoutes = (app: Hono<AppEnv>) => {
  app.get(route, async (c) => {
    const owner = session(c);
    c.header("Cache-Control", "no-store");
    const { results } = await c.env.storage.db.prepare(`SELECT * FROM document_imports
      WHERE user_id=? AND workspace_id=?
      ORDER BY CASE WHEN state IN ('queued','processing') THEN 0 ELSE 1 END, created_at DESC LIMIT 50`)
      .bind(owner.userId, owner.workspaceId).all<Job>();
    return c.json({ imports: results.map(view) });
  });

  app.post(route, bodyLimit({ maxSize: maxUpload + 1024 * 1024 }), async (c) => {
    const owner = session(c);
    c.header("Cache-Control", "no-store");
    const form = await c.req.raw.formData();
    const id = form.get("id");
    const notebookId = form.get("notebookId");
    const proof = form.get("proof");
    const file = form.get("file");
    if (typeof id !== "string" || !uuid.test(id) || typeof notebookId !== "string" ||
        typeof proof !== "string" || !(file instanceof File)) {
      throw new AppError("document_invalid_input", "A valid import ID, notebook and file are required.", 400);
    }
    const filename = file.name.split(/[\\/]/).at(-1) ?? "";
    const ext = filename.split(".").at(-1)?.toLowerCase();
    const mime = ext && Object.hasOwn(types, ext) ? types[ext as keyof typeof types] : null;
    if (!mime || new TextEncoder().encode(filename).length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
      throw new AppError("document_unsupported_type", "Select a DOCX, XLSX, PPTX or PDF file.", 415);
    }
    if (!file.size || file.size > maxUpload) {
      throw new AppError("document_too_large", "The file must be between 1 byte and 100 MiB.", 413);
    }
    await verifyHybragSessionIdentity(c, proof);
    if (!(await notebookExists(c.env.storage.db, owner.workspaceId, notebookId))) {
      throw new AppError("document_notebook_unavailable", "The target notebook is unavailable.", 404);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Bytes(bytes);
    const job: Job = {
      id, notebook_id: notebookId, workspace_id: owner.workspaceId, user_id: owner.userId,
      filename, mime_type: mime, source_hash: hash, remote_id: id, remote_token: makeToken(),
      state: "queued", error_code: null, memo_id: null, created_at: now(), updated_at: now(),
    };
    const created = await c.env.storage.db.prepare(`INSERT INTO document_imports
      (id,user_id,workspace_id,notebook_id,filename,mime_type,source_hash,remote_id,remote_token,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`)
      .bind(id, job.user_id, job.workspace_id, notebookId, filename, mime, hash, id, job.remote_token, job.state, job.created_at, job.updated_at).first();
    if (!created) {
      const existing = await findJob(c.env, id, owner.userId, owner.workspaceId);
      if (!existing || existing.source_hash !== hash || existing.notebook_id !== notebookId || existing.filename !== filename) {
        throw new AppError("document_import_conflict", "This import ID is already in use.", 409);
      }
      return c.json({ import: view(existing) }, 202);
    }
    try {
      await c.env.storage.resources.put(sourceKey(job), bytes);
      await submit(c.env, job, proof);
    } catch {
      await setState(c.env, job, "failed", "document_service_unavailable");
    }
    return c.json({ import: view((await findJob(c.env, id, owner.userId, owner.workspaceId)) ?? job) }, 202);
  });

  app.post(`${route}/:id/retry`, bodyLimit({ maxSize: 32768 }), async (c) => {
    const owner = session(c);
    c.header("Cache-Control", "no-store");
    const input = await c.req.json<{ proof?: string }>();
    const proof = typeof input?.proof === "string" ? input.proof : "";
    await verifyHybragSessionIdentity(c, proof);
    const job = await findJob(c.env, c.req.param("id"), owner.userId, owner.workspaceId);
    if (!job) throw new AppError("not_found", "Import not found.", 404);
    if (job.state !== "failed" || job.error_code === "document_source_missing") return c.json({ import: view(job) }, 202);
    if (!(await notebookExists(c.env.storage.db, owner.workspaceId, job.notebook_id))) {
      throw new AppError("document_notebook_unavailable", "The target notebook is unavailable.", 404);
    }
    const restarted = await c.env.storage.db.prepare(`UPDATE document_imports SET state='queued',error_code=NULL,
      remote_id=?,remote_token=?,updated_at=?,remote_confirmed=0,pages_done=NULL,pages_total=NULL WHERE id=? AND state='failed' AND remote_id=? AND error_code<>'document_source_missing' RETURNING *`)
      .bind(crypto.randomUUID(), makeToken(), now(), job.id, job.remote_id).first<Job>();
    if (restarted) await submit(c.env, restarted, proof);
    return c.json({ import: view((await findJob(c.env, job.id, owner.userId, owner.workspaceId)) ?? job) }, 202);
  });
};

type ParsedDocument = {
  markdown: string;
  images: { ref: string; filename: string; mimeType: string }[];
};

const publish = async (env: Bindings, job: Job, result: ParsedDocument, auth: Record<string, string>) => {
  const db = env.storage.db;
  const owner = await db.prepare(`SELECT 1 FROM workspace_members wm JOIN users u ON u.id=wm.user_id
    JOIN user_identities i ON i.user_id=u.id AND i.provider='vos'
    JOIN workspaces w ON w.id=wm.workspace_id AND w.is_personal=1
    WHERE wm.workspace_id=? AND wm.user_id=? AND wm.role='owner' AND u.is_disabled=0
      AND NOT EXISTS (SELECT 1 FROM workspace_members peer WHERE peer.workspace_id=w.id AND peer.user_id<>wm.user_id)`)
    .bind(job.workspace_id, job.user_id).first();
  if (!owner || !(await notebookExists(db, job.workspace_id, job.notebook_id))) {
    throw new AppError("document_notebook_unavailable", "The target notebook is unavailable.", 404);
  }
  const source = await env.storage.resources.get(sourceKey(job));
  if (!source) throw new AppError("document_source_missing", "The source file is unavailable.", 404);
  const destination = await resolveObjectStorage(env);
  const memoId = `memo_${job.id}`;
  const storageKeys: string[] = [];
  const statements: PreparedStatementAdapter[] = [];
  const timestamp = now();
  let markdown = result.markdown;
  const refs = new Map<string, string>();
  const addResource = async (id: string, filename: string, mimeType: string, data: ArrayBuffer,
    size: number, hash: string, kind: "image" | "attachment") => {
    const key = `workspaces/${job.workspace_id}/memos/${memoId}/${id}`;
    storageKeys.push(key);
    await destination.store.put(key, data, { httpMetadata: { contentType: mimeType, cacheControl: "private, max-age=3600" } });
    statements.push(db.prepare(`INSERT INTO resources
      (id,memo_id,bucket_name,object_key,storage_config_id,kind,mime_type,filename,byte_size,sha256,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, memoId, destination.bucketName, key, destination.configId, kind, mimeType, filename, size, hash, "{}", timestamp, timestamp));
  };
  try {
    const originalId = `res_${job.id}_original`;
    await addResource(originalId, job.filename, job.mime_type, await new Response(source.body).arrayBuffer(),
      source.size, job.source_hash, "attachment");
    for (const [index, image] of result.images.entries()) {
      if (!imageTypes.has(image.mimeType) || !image.ref || refs.has(image.ref)) continue;
      const id = `res_${job.id}_${index}`;
      const response = await fetch(`${remoteURL(env, job)}/images/${index}`, {
        headers: auth, redirect: "error", signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error("Could not retrieve document image.");
      const data = await response.arrayBuffer();
      await addResource(id, image.filename, image.mimeType, data, data.byteLength,
        await sha256Bytes(new Uint8Array(data)), "image");
      refs.set(image.ref, `/api/v1/resources/${id}/blob`);
    }
    markdown = markdown.replace(/(!\[[^\]\n]*\]\()<?([^\n>]+?)>?(\))/g,
      (_match, opening: string, ref: string, closing: string) => {
        const owned = refs.get(ref);
        const cleanRef = ref.trim();
        return owned ? opening + owned + closing : cleanRef.startsWith("images/") ? opening.slice(2, -2) : _match;
      });
    markdown += "\n\n" + resourceLinkToMarkdown(job.filename, `/api/v1/resources/${originalId}/blob`);
    statements.push(db.prepare(`UPDATE document_imports SET state='completed',memo_id=?,error_code=NULL,updated_at=?,cleanup_pending=1
      WHERE id=? AND remote_id=? AND state IN ('queued','processing')`).bind(memoId, timestamp, job.id, job.remote_id));
    await createMemoRecord(db, job.workspace_id, {
      notebookId: job.notebook_id,
      title: job.filename.replace(/\.[^.]+$/, ""),
      contentMarkdown: markdown,
    }, { actorType: "user", actorId: job.user_id }, `user:${job.user_id}`,
    { memoId, statements, personalOwnerId: job.user_id });
  } catch (error) {
    const current = await findJob(env, job.id, job.user_id, job.workspace_id);
    if (current?.state !== "completed" && storageKeys.length) await destination.store.delete(storageKeys);
    throw error;
  }
};

export const maintainDocumentImports = async (env: Bindings) => {
  if (!isVosMode(env)) return;
  const db = env.storage.db;
  const { results } = await db.prepare(`SELECT * FROM document_imports WHERE state IN ('queued','processing')
    ORDER BY updated_at LIMIT 10`).all<Job>();
  for (const job of results) {
    try {
      const auth = { Authorization: `Document ${job.remote_token}` };
      const url = remoteURL(env, job);
      const response = await fetch(url, { headers: auth, redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (response.status === 404 && Date.now() - Date.parse(job.updated_at) > 120_000) {
        await setState(env, job, "failed", job.remote_confirmed ? "document_result_expired" : "document_service_unavailable");
      } else if (response.status === 202) {
        const progress = await response.json() as { processing?: boolean; done?: number; total?: number };
        await db.prepare(`UPDATE document_imports SET state=?,pages_done=?,pages_total=?,updated_at=?,remote_confirmed=1
          WHERE id=? AND remote_id=? AND state IN ('queued','processing')`)
          .bind(progress.processing ? "processing" : "queued", progress.done ?? null, progress.total ?? null,
            now(), job.id, job.remote_id).run();
      } else if (response.status === 422) {
        const { code } = await response.json() as { code: string };
        await setState(env, job, "failed", code);
      } else if (response.ok) {
        const result = await response.json() as ParsedDocument;
        if (typeof result.markdown !== "string" || !Array.isArray(result.images)) {
          await setState(env, job, "failed", "document_parse_failed");
        } else {
          await publish(env, job, result, auth);
        }
      }
      if (response.status === 422) {
        await fetch(url, { method: "DELETE", headers: auth, redirect: "error", signal: AbortSignal.timeout(10_000) });
      }
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        await setState(env, job, "failed", error.code);
      } else if (Date.now() - Date.parse(job.updated_at) > (job.remote_confirmed ? 24 * 60 * 60 * 1000 : 120_000)) {
        await setState(env, job, "failed", "document_service_unavailable");
      }
      // Transient failures leave the remote result available.
    }
  }
  const completed = await db.prepare("SELECT * FROM document_imports WHERE cleanup_pending=1 LIMIT 10").all<Job>();
  for (const job of completed.results) {
    try {
      await env.storage.resources.delete(sourceKey(job));
      const response = await fetch(remoteURL(env, job), {
        method: "DELETE", headers: { Authorization: `Document ${job.remote_token}` },
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || response.status === 404) {
        await db.prepare("UPDATE document_imports SET cleanup_pending=0 WHERE id=?").bind(job.id).run();
      }
    } catch {
      // Retry cleanup after a temporary storage or transport error.
    }
  }
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const expired = await db.prepare("SELECT * FROM document_imports WHERE state='failed' AND updated_at<? LIMIT 10")
    .bind(cutoff).all<Job>();
  for (const job of expired.results) {
    const removed = await db.prepare("DELETE FROM document_imports WHERE id=? AND state='failed' AND updated_at<? RETURNING id")
      .bind(job.id, cutoff).first();
    if (removed) await env.storage.resources.delete(sourceKey(job));
  }
};
