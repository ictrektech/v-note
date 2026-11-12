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
