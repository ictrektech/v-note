import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchEdgeEverApp } from "./index.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

const resources = [];
const servers = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of resources.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const createEnvironment = () => {
  const sqlite = new Database(":memory:");
  for (const path of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(path, "utf8"));
  }
  const directory = mkdtempSync(join(tmpdir(), "v-note-vos-app-"));
  resources.push(directory);
  return {
    sqlite,
    environment: {
      storage: createSelfHostedStorageAdapter(sqlite, directory),
      EDGE_EVER_VOS_MODE: "true",
      EDGE_EVER_VOS_USERINFO_URL: "http://127.0.0.1:1/userinfo",
    },
  };
};

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
};

describe("VOS app routing", () => {
  test("reports VOS auth mode without a bootstrap user", async () => {
    const { environment } = createEnvironment();
    const response = await fetchEdgeEverApp(
      new Request("http://localhost/api/health"),
      environment,
      executionContext,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).authMode).toBe("vos");
  });

  test("returns an anonymous VOS session instead of auth_not_configured", async () => {
    const { environment } = createEnvironment();
    const response = await fetchEdgeEverApp(
      new Request("http://localhost/api/v1/auth/session"),
      environment,
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authRequired: true,
      authenticated: false,
      vosMode: true,
      user: null,
    });
  });

  test("rejects VOS SSO without a bearer token", async () => {
    const { environment } = createEnvironment();
    const response = await fetchEdgeEverApp(
      new Request("http://localhost/api/v1/auth/vos", { method: "POST" }),
      environment,
      executionContext,
    );
    expect(response.status).toBe(401);
  });

  test("exchanges a VOS token for an EdgeEver session and maps an administrator", async () => {
    const userinfo = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== "Bearer vos-user-token") {
          return Response.json({ error: "invalid_token" }, { status: 401 });
        }
        return Response.json({
          sub: "vos-route-admin",
          preferred_username: "route-admin",
          nickname: "Route Admin",
          role_code: "platform_admin",
          enable: 1,
        });
      },
    });
    servers.push(userinfo);
    const { environment } = createEnvironment();
    environment.EDGE_EVER_VOS_USERINFO_URL = `http://127.0.0.1:${userinfo.port}/userinfo`;

    const login = await fetchEdgeEverApp(
      new Request("http://localhost/api/v1/auth/vos", {
        method: "POST",
        headers: { Authorization: "Bearer vos-user-token" },
      }),
      environment,
      executionContext,
    );
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({
      authenticated: true,
      vosMode: true,
      user: { username: expect.stringMatching(/^vos_/), displayName: "Route Admin", role: "owner" },
    });
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("edgeever_session=");

    const session = await fetchEdgeEverApp(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { Cookie: cookie.split(";", 1)[0] },
      }),
      environment,
      executionContext,
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      vosMode: true,
      user: { displayName: "Route Admin", role: "owner" },
    });
  });

  test("pairs each VOS user with their own workspace and rejects unusable codes", async () => {
    const { sqlite, environment } = createEnvironment();
    const userinfo = Bun.serve({
      port: 0,
      fetch(request) {
        const subject = request.headers.get("authorization")?.slice(7);
        if (!["alice", "bob", "disabled"].includes(subject)) return new Response(null, { status: 401 });
        return Response.json({ sub: subject, preferred_username: subject, enable: subject !== "disabled" });
      },
    });
    servers.push(userinfo);
    environment.EDGE_EVER_VOS_USERINFO_URL = `http://127.0.0.1:${userinfo.port}/userinfo`;

    const request = (path, init) => fetchEdgeEverApp(new Request(`http://localhost/api/v1/${path}`, init), environment, executionContext);
    const vos = (route, token) => request(route, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const issue = (token) => vos("auth/vos/pairing", token);
    const login = (username, password) => request("auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const notebooks = async (authorization) => {
      const response = await request("notebooks", { headers: authorization });
      expect(response.status).toBe(200);
      return (await response.json()).notebooks.map(({ id }) => id);
    };
    expect((await issue()).status).toBe(401);
    expect((await issue("invalid")).status).toBe(401);
    expect((await issue("disabled")).status).toBe(403);
    expect((await issue("alice")).status).toBe(403);

    const aliceWeb = await vos("auth/vos", "alice");
    const alice = await aliceWeb.json();
    const bobWeb = await vos("auth/vos", "bob");
    const bob = await bobWeb.json();
    const aliceNotebooks = await notebooks({ Cookie: aliceWeb.headers.get("set-cookie").split(";")[0] });
    const bobNotebooks = await notebooks({ Cookie: bobWeb.headers.get("set-cookie").split(";")[0] });
    expect(aliceNotebooks.length).toBeGreaterThan(0);
    expect(bobNotebooks.some((id) => aliceNotebooks.includes(id))).toBe(false);

    const expired = await (await issue("alice")).json();
    sqlite.query("UPDATE vos_mobile_pairings SET expires_at = ? WHERE user_id = ?")
      .run("2000-01-01T00:00:00.000Z", alice.user.id);
    expect((await login(alice.user.username, expired.code)).status).toBe(401);

    const replaced = await (await issue("alice")).json();
    const issued = await issue("alice");
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const pairing = await issued.json();
    expect(pairing.username).toBe(alice.user.username);
    expect(Date.parse(pairing.expiresAt) - Date.now()).toBeGreaterThan(290_000);
    expect(sqlite.query("SELECT code_hash FROM vos_mobile_pairings").get().code_hash).not.toContain(pairing.code);
    expect((await login(pairing.username, replaced.code)).status).toBe(401);
    expect((await login(bob.user.username, pairing.code)).status).toBe(401);

    const attempts = await Promise.all([login(pairing.username, pairing.code), login(pairing.username, pairing.code)]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 401]);
    const mobile = await attempts.find((response) => response.ok).json();
    expect(mobile.user).toEqual(alice.user);
    expect(await notebooks({ Authorization: `Bearer ${mobile.sessionToken}` })).toEqual(aliceNotebooks);
  });

  test("disables public shares, notebook publishing, and forms", async () => {
    const { environment } = createEnvironment();
    for (const path of [
      "/api/public/shares/token",
      "/api/public/notebook-shares/token",
      "/api/public/forms/token",
      "/api/v1/memos/memo-1/share",
      "/api/v1/notebooks/nb-1/share",
    ]) {
      const response = await fetchEdgeEverApp(
        new Request(`http://localhost${path}`),
        environment,
        executionContext,
      );
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("public_sharing_disabled");
    }
  });
});
