import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { provisionVosUser } from "./vos-auth.ts";
import { registerHybragIdentityRoutes } from "./hybrag-identity.ts";

const resources = [];
afterEach(() => { for (const close of resources.splice(0)) close(); });

const fixture = async () => {
  const database = new Database(":memory:");
  resources.push(() => database.close());
  for (const name of globSync("migrations/*.sql").sort()) database.exec(readFileSync(name, "utf8"));
  const directory = mkdtempSync(join(tmpdir(), "vnote-hybrag-identity-"));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  const storage = createSelfHostedStorageAdapter(database, directory);
  const owner = await provisionVosUser(storage.db, { subject: "owner-sub", username: "owner", displayName: "Owner", role: "owner" });
  const member = await provisionVosUser(storage.db, { subject: "member-sub", username: "member", displayName: "Member", role: "member" });
  const workspaceFor = (id) => database.query("SELECT workspace_id FROM workspace_members WHERE user_id = ?").get(id).workspace_id;
  const server = Bun.serve({ port: 0, fetch(request) {
    const subject = request.headers.get("authorization") === "Bearer member-proof" ? "member-sub" : "owner-sub";
    return Response.json({ sub: subject, preferred_username: "renamed", enable: 1 });
  } });
  resources.push(() => server.stop(true));
  const environment = { storage, EDGE_EVER_VOS_MODE: "true", EDGE_EVER_VOS_USERINFO_URL: `http://127.0.0.1:${server.port}/userinfo` };
  const request = async (user, workspace, token, kind = "user") => {
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("auth", { kind, actorType: kind, actorId: user.id, workspaceId: workspace, role: "owner", scopes: [], sessionId: kind === "user" ? "session" : undefined });
      await next();
    });
    app.onError((error, context) => context.json({ code: error.code }, error.status ?? 500));
    registerHybragIdentityRoutes(app);
    return app.request("/api/v1/integrations/hybrag/identity", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: token }),
    }, environment);
  };
  return { owner, member, database, workspaceFor, request };
};

describe("HybRAG user identity proof", () => {
  test("verifies the session's stable VOS subject despite a renamed display name", async () => {
    const f = await fixture();
    const result = await f.request(f.owner.user, f.workspaceFor(f.owner.user.id), "owner-proof");
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ verified: true, identity: { subject: "owner-sub", userId: f.owner.user.id, workspaceId: f.workspaceFor(f.owner.user.id) } });
  });

  test("administrators cannot substitute another user's proof or workspace", async () => {
    const f = await fixture();
    const wrongProof = await f.request(f.owner.user, f.workspaceFor(f.owner.user.id), "member-proof");
    expect(wrongProof.status).toBe(403);
    expect((await wrongProof.json()).code).toBe("hybrag_identity_mismatch");
    const wrongWorkspace = await f.request(f.owner.user, f.workspaceFor(f.member.user.id), "owner-proof");
    expect(wrongWorkspace.status).toBe(403);
  });

  test("rejects API agents, locally disabled users and application service tokens", async () => {
    const f = await fixture();
    const workspace = f.workspaceFor(f.owner.user.id);
    expect((await f.request(f.owner.user, workspace, "owner-proof", "agent")).status).toBe(403);
    for (const application of ["app", "platform"]) {
      const service = `header.${Buffer.from(JSON.stringify({ application })).toString("base64url")}.signature`;
      const result = await f.request(f.owner.user, workspace, service);
      expect(result.status).toBe(403);
      expect((await result.json()).code).toBe("vos_service_credential_rejected");
    }
    f.database.query("UPDATE users SET is_disabled = 1 WHERE id = ?").run(f.owner.user.id);
    expect((await f.request(f.owner.user, workspace, "owner-proof")).status).toBe(403);
  });
});
