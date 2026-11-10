import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { provisionVosUser, verifyVosAccessToken } from "./vos-auth.ts";
import { isVosDisabledApiPath, isVosMode } from "./vos-mode.ts";

const databases = [];
const directories = [];
const servers = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const createStorage = () => {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  for (const path of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(path, "utf8"));
  }
  const directory = mkdtempSync(join(tmpdir(), "v-note-vos-"));
  directories.push(directory);
  return { sqlite, storage: createSelfHostedStorageAdapter(sqlite, directory) };
};

describe("VOS identity provisioning", () => {
  test("creates one personal workspace and keeps the VOS role current", async () => {
    const { sqlite, storage } = createStorage();
    const first = await provisionVosUser(storage.db, {
      subject: "vos-subject-1",
      username: "Alice",
      displayName: "Alice",
      role: "owner",
    }, "zh-CN");
    const second = await provisionVosUser(storage.db, {
      subject: "vos-subject-1",
      username: "Alice",
      displayName: "Alice Updated",
      role: "member",
    }, "zh-CN");

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.display_name).toBe("Alice Updated");
    expect(second.role).toBe("member");
    expect(sqlite.query("SELECT COUNT(*) AS count FROM user_identities WHERE provider = 'vos'").get().count).toBe(1);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM workspace_example_seeds WHERE workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)").get(first.user.id).count).toBe(0);
    expect(sqlite.query("SELECT role FROM workspace_members WHERE user_id = ?").get(first.user.id).role).toBe("member");
    expect(sqlite.query("SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = (SELECT workspace_id FROM workspace_members WHERE user_id = ?)").get(first.user.id).count).toBeGreaterThan(0);
  });

  test("keeps separate users and owners isolated in their own workspaces", async () => {
    const { sqlite, storage } = createStorage();
    const admin = await provisionVosUser(storage.db, {
      subject: "vos-admin",
      username: "Admin",
      displayName: "Admin",
      role: "owner",
    }, "en-US");
    const member = await provisionVosUser(storage.db, {
      subject: "vos-member",
      username: "Member",
      displayName: "Member",
      role: "member",
    }, "en-US");

    const rows = sqlite.query(
      "SELECT user_id, workspace_id, role FROM workspace_members WHERE user_id IN (?, ?) ORDER BY user_id",
    ).all(admin.user.id, member.user.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].workspace_id).not.toBe(rows[1].workspace_id);
    expect(rows.find((row) => row.user_id === admin.user.id).role).toBe("owner");
    expect(rows.find((row) => row.user_id === member.user.id).role).toBe("member");
  });
});

describe("VOS access-token verification", () => {
  const startUserinfoServer = (body) => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== "Bearer valid-token") {
          return Response.json({ error: "invalid_token" }, { status: 401 });
        }
        return Response.json(body);
      },
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}/userinfo`;
  };

  test("maps enabled administrators to owners and forwards the bearer token", async () => {
    const url = startUserinfoServer({
      sub: "admin-sub",
      preferred_username: "admin",
      nickname: "VOS Admin",
      role_code: "system_admin",
      enable: 1,
    });
    const user = await verifyVosAccessToken({ EDGE_EVER_VOS_USERINFO_URL: url }, "valid-token");
    expect(user).toEqual({
      subject: "admin-sub",
      username: "admin",
      displayName: "VOS Admin",
      role: "owner",
    });
  });

  test("rejects disabled and invalid VOS users", async () => {
    const disabledUrl = startUserinfoServer({
      sub: "disabled-sub",
      preferred_username: "disabled",
      role_code: "member",
      enable: 0,
    });
    await expect(verifyVosAccessToken({ EDGE_EVER_VOS_USERINFO_URL: disabledUrl }, "valid-token"))
      .rejects.toMatchObject({ code: "vos_user_disabled", status: 403 });

    const invalidUrl = startUserinfoServer({ sub: "", enable: 1 });
    await expect(verifyVosAccessToken({ EDGE_EVER_VOS_USERINFO_URL: invalidUrl }, "valid-token"))
      .rejects.toMatchObject({ code: "vos_userinfo_invalid", status: 502 });

    await expect(verifyVosAccessToken({ EDGE_EVER_VOS_USERINFO_URL: disabledUrl }, "wrong-token"))
      .rejects.toMatchObject({ code: "vos_auth_rejected", status: 401 });
  });
});

describe("VOS feature boundary", () => {
  test("recognizes VOS mode and disabled public surfaces", () => {
    expect(isVosMode({ EDGE_EVER_VOS_MODE: "true" })).toBe(true);
    expect(isVosMode({ EDGE_EVER_VOS_MODE: "false" })).toBe(false);
    expect(isVosDisabledApiPath("/api/public/shares/token")).toBe(true);
    expect(isVosDisabledApiPath("/api/v1/memos/memo-1/share")).toBe(true);
    expect(isVosDisabledApiPath("/api/v1/memos/memo-1")).toBe(false);
    expect(isVosDisabledApiPath("/api/v1/notebooks/nb-1/share/site")).toBe(true);
  });
});
