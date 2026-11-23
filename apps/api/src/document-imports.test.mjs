import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { maintainDocumentImports, registerDocumentImportRoutes } from "./document-imports.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { provisionVosUser } from "./vos-auth.ts";

const route = "/api/v1/integrations/hybrag/document-imports";
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup() {
  const database = new Database(":memory:");
  cleanups.push(() => database.close());
  for (const name of globSync("migrations/*.sql").sort()) database.exec(readFileSync(name, "utf8"));
  database.exec("PRAGMA foreign_keys = ON");
  const directory = mkdtempSync(join(tmpdir(), "vnote-document-import-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const storage = createSelfHostedStorageAdapter(database, directory);

  const createUser = async (username) => {
    const { user } = await provisionVosUser(storage.db, { subject: username, username, displayName: username, role: "owner" });
    const { workspace_id } = database.query("SELECT workspace_id FROM workspace_members WHERE user_id=?").get(user.id);
    return { kind: "user", actorType: "user", actorId: user.id, workspaceId: workspace_id, sessionId: "test" };
  };
  const owner = await createUser("owner");
  const other = await createUser("other");
  database.query("INSERT INTO notebooks(id,workspace_id,name) VALUES (?,?,?)").run("root", owner.workspaceId, "Root");

  const parser = { ready: false, files: new Map(), submitted: 0 };
  const target = Bun.serve({ port: 0, async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/userinfo") return Response.json({ sub: "owner", enable: 1 });
    const id = pathname.split("/")[5];
    const saved = parser.files.get(id);
    if (request.method === "PUT") {
      expect(request.headers.get("Authorization")).toBe("Bearer owner-proof");
      expect(await request.text()).toBe("%PDF-1.7 sample");
      parser.submitted++;
      parser.files.set(id, request.headers.get("X-Document-Token"));
      return new Response(null, { status: 202 });
    }
    if (!saved || request.headers.get("Authorization") !== `Document ${saved}`) {
      return new Response(null, { status: 404 });
    }
    if (request.method === "DELETE") {
      parser.files.delete(id);
      return new Response(null, { status: 204 });
    }
    if (!parser.ready) return Response.json({ processing: true, done: 9, total: 10 }, { status: 202 });
    if (pathname.endsWith("/images/0")) return new Response(Uint8Array.of(0xff, 0xd8, 0xff));
    return Response.json({
      markdown: "# Editable\n\n![Page](images/page.jpg)",
      images: [{ ref: "images/page.jpg", filename: "page.jpg", mimeType: "image/jpeg" }],
    });
  } });
  cleanups.push(() => target.stop(true));
  const env = {
    storage, EDGE_EVER_VOS_MODE: "true",
    EDGE_EVER_HYBRAG_URL: `http://127.0.0.1:${target.port}`,
    EDGE_EVER_VOS_USERINFO_URL: `http://127.0.0.1:${target.port}/userinfo`,
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", c.req.header("X-Test-User") === "other" ? other : owner);
    await next();
  });
  app.onError((error, c) => c.json({ code: error.code }, error.status ?? 500));
  registerDocumentImportRoutes(app);
  const id = crypto.randomUUID();
  const submit = () => {
    const form = new FormData();
    form.set("id", id);
    form.set("notebookId", "root");
    form.set("file", new File(["%PDF-1.7 sample"], "sample.pdf"));
    form.set("proof", "owner-proof");
    return app.request(route, { method: "POST", body: form }, env);
  };
  const list = async (otherUser = false) => {
    const response = await app.request(route, { headers: { "X-Test-User": otherUser ? "other" : "owner" } }, env);
    return (await response.json()).imports;
  };
  return { database, env, parser, submit, list };
}

test("publishes one editable note and its resources when the background parser finishes", async () => {
  const { database, env, parser, submit, list } = await setup();
  expect((await submit()).status).toBe(202);
  expect((await submit()).status).toBe(202);
  expect(parser.submitted).toBe(1);
  await maintainDocumentImports(env);
  expect((await list())[0]).toMatchObject({ state: "processing", pagesDone: 9, pagesTotal: 10 });
  expect(await list(true)).toEqual([]);

  parser.ready = true;
  await maintainDocumentImports(env);
  await maintainDocumentImports(env);
  const [job] = await list();
  expect(job).toMatchObject({ state: "completed", filename: "sample.pdf" });
  expect(database.query("SELECT content_markdown FROM memo_contents WHERE memo_id=?").get(job.memoId).content_markdown)
    .toContain("# Editable");
  expect(database.query("SELECT kind FROM resources WHERE memo_id=? ORDER BY kind").all(job.memoId))
    .toEqual([{ kind: "attachment" }, { kind: "image" }]);
  expect(parser.files.size).toBe(0);
});

test("a deleted destination prevents background publication", async () => {
  const { database, env, parser, submit, list } = await setup();
  expect((await submit()).status).toBe(202);
  database.query("UPDATE notebooks SET is_deleted=1 WHERE id='root'").run();
  parser.ready = true;
  await maintainDocumentImports(env);
  expect((await list())[0]).toMatchObject({ state: "failed", errorCode: "document_notebook_unavailable", memoId: null });
  expect(database.query("SELECT COUNT(*) AS total FROM memos WHERE notebook_id=?").get("root").total).toBe(0);
});
