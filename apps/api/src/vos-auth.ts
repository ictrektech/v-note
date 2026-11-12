import type { Hono } from "hono";
import type { UserRow } from "./auth-routes";
import { createSession, getBearerToken, setSessionCookie } from "./auth-service";
import { hashPassword, randomToken } from "./auth-crypto";
import type { AppEnv, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { isoNow } from "./entity-utils";
import { sha256 } from "./hash-utils";
import { notFound, unauthorized } from "./http-errors";
import {
  createDefaultNotebookRows,
  createWorkspaceDefaultSeedStatements,
} from "./workspace-provisioning";
import type { DatabaseAdapter } from "./storage-contract";
import { isVosMode } from "./vos-mode";
import { issueVosMobilePairing } from "./vos-mobile-pairing";

type VosUserInfo = {
  sub: string;
  preferred_username?: string;
  nickname?: string;
  email?: string;
  role_code?: string;
  enable?: boolean | number;
};

export type VosUser = {
  subject: string;
  username: string;
  displayName: string;
  role: "owner" | "member";
};

export type VosProvisionedUser = {
  user: UserRow;
  role: "owner" | "member";
};

const VOS_USERINFO_MAX_BYTES = 64 * 1024;
const VOS_USERINFO_TIMEOUT_MS = 10_000;

const isEnabled = (value: VosUserInfo["enable"]) => value === true || value === 1;

const isAdminRole = (roleCode: string | undefined) =>
  roleCode === "system_admin" || roleCode === "platform_admin";

const firstText = (...values: Array<string | undefined>) =>
  values.map((value) => value?.trim()).find(Boolean) ?? "";

/**
 * Verify a VOS application access token against the platform userinfo endpoint.
 * The token is never written to the database or logs.
 */
export const verifyVosAccessToken = async (env: Bindings, token: string): Promise<VosUser> => {
  const userinfoUrl = env.EDGE_EVER_VOS_USERINFO_URL?.trim();
  if (!userinfoUrl) {
    throw new AppError(
      "vos_userinfo_not_configured",
      "VOS userinfo URL is not configured for this instance.",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(VOS_USERINFO_TIMEOUT_MS),
    });
  } catch {
    throw new AppError("vos_userinfo_unreachable", "VOS identity service is unavailable.", 503);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AppError("vos_auth_rejected", "VOS sign-in was rejected.", 401);
  }
  if (text.length > VOS_USERINFO_MAX_BYTES) {
    throw new AppError("vos_userinfo_invalid", "VOS userinfo response is too large.", 502);
  }

  let body: VosUserInfo;
  try {
    body = JSON.parse(text) as VosUserInfo;
  } catch {
    throw new AppError("vos_userinfo_invalid", "VOS userinfo response is invalid.", 502);
  }

  if (!body || typeof body.sub !== "string" || !body.sub.trim()) {
    throw new AppError("vos_userinfo_invalid", "VOS userinfo is missing a subject.", 502);
  }
  if (!isEnabled(body.enable)) {
    throw new AppError("vos_user_disabled", "This VOS user is disabled.", 403);
  }

  const subject = body.sub.trim();
  const username = firstText(body.preferred_username, body.nickname, body.email, subject);
  const displayName = firstText(body.nickname, body.preferred_username, body.email, subject);
  return {
    subject,
    username,
    displayName,
    role: isAdminRole(body.role_code) ? "owner" : "member",
  };
};

const readUser = (db: DatabaseAdapter, userId: string) =>
  db.prepare(
    `SELECT id, username, password_hash, display_name, is_disabled
     FROM users WHERE id = ?`,
  ).bind(userId).first<UserRow>();

const readMappedUser = (db: DatabaseAdapter, subject: string) =>
  db.prepare(
    `SELECT u.id, u.username, u.password_hash, u.display_name, u.is_disabled
     FROM user_identities i
     INNER JOIN users u ON u.id = i.user_id
     WHERE i.provider = 'vos' AND i.subject = ?`,
  ).bind(subject).first<UserRow>();

const ensureWorkspaceRole = async (
  db: DatabaseAdapter,
  userId: string,
  workspaceId: string,
  role: "owner" | "member",
  now: string,
) => {
  await db.prepare(
    `UPDATE workspace_members SET role = ?
     WHERE workspace_id = ? AND user_id = ?`,
  ).bind(role, workspaceId, userId).run();
  await db.prepare(
    `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(workspaceId, userId, role, now).run();
};

/**
 * Create or refresh a VOS-backed EdgeEver account. Each VOS subject gets its
 * own personal workspace; VOS administrators own their own workspace but do
 * not gain access to other users' notes.
 */
export const provisionVosUser = async (
  db: DatabaseAdapter,
  vosUser: VosUser,
  locale?: string | null,
): Promise<VosProvisionedUser> => {
  const now = isoNow();
  const mapped = await readMappedUser(db, vosUser.subject);
  if (mapped) {
    const workspace = await db.prepare(
      `SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1`,
    ).bind(mapped.id).first<{ workspace_id: string }>();
    await db.prepare(
      `UPDATE users SET display_name = ?, is_disabled = 0, updated_at = ? WHERE id = ?`,
    ).bind(vosUser.displayName, now, mapped.id).run();
    if (workspace) {
      await ensureWorkspaceRole(db, mapped.id, workspace.workspace_id, vosUser.role, now);
    }
    const refreshed = await readUser(db, mapped.id);
    if (!refreshed) throw new AppError("vos_user_missing", "Mapped VOS user no longer exists.", 500);
    return { user: refreshed, role: vosUser.role };
  }

  const digest = await sha256(vosUser.subject);
  const userId = `usr_vos_${digest.slice(0, 24)}`;
  const workspaceId = `ws_vos_${digest.slice(0, 24)}`;
  const username = `vos_${digest.slice(0, 20)}`;
  const passwordHash = await hashPassword(randomToken(32));
  const notebooks = createDefaultNotebookRows(workspaceId, locale);
  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO users (
         id, username, password_hash, display_name, is_disabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).bind(userId, username, passwordHash, vosUser.displayName, now, now),
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, is_personal, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).bind(workspaceId, `${vosUser.displayName}'s workspace`, now, now),
    db.prepare(
      `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(workspaceId, userId, vosUser.role, now),
    ...notebooks.map((notebook) => db.prepare(
      `INSERT OR IGNORE INTO notebooks (
         id, workspace_id, parent_id, name, slug, icon, color, sort_order, created_at, updated_at
       ) VALUES (?, ?, NULL, ?, ?, 'notebook', ?, ?, ?, ?)`,
    ).bind(notebook.id, workspaceId, notebook.name, notebook.slug, notebook.color, notebook.sortOrder, now, now)),
    ...createWorkspaceDefaultSeedStatements(db, workspaceId, now, locale),
    db.prepare(
      `INSERT OR IGNORE INTO user_identities (provider, subject, user_id, created_at, updated_at)
       VALUES ('vos', ?, ?, ?, ?)`,
    ).bind(vosUser.subject, userId, now, now),
  ];
  await db.batch(statements);

  // Two first logins can race. The deterministic user/workspace ids and
  // INSERT OR IGNORE keep the loser idempotent.
  const user = await readMappedUser(db, vosUser.subject) ?? await readUser(db, userId);
  if (!user) throw new AppError("vos_user_provision_failed", "Could not create the VOS user.", 500);
  await ensureWorkspaceRole(db, user.id, workspaceId, vosUser.role, now);
  await db.prepare(
    `UPDATE users SET display_name = ?, is_disabled = 0, updated_at = ? WHERE id = ?`,
  ).bind(vosUser.displayName, now, user.id).run();
  const refreshed = await readUser(db, user.id);
  if (!refreshed) throw new AppError("vos_user_provision_failed", "Could not read the VOS user.", 500);
  return { user: refreshed, role: vosUser.role };
};

export const registerVosAuthRoutes = (
  app: Hono<AppEnv>,
  dependencies: {
    createSession: typeof createSession;
    setSessionCookie: typeof setSessionCookie;
  },
) => {
  app.post("/api/v1/auth/vos/pairing", async (context) => {
    if (!isVosMode(context.env)) return notFound(context, "VOS authentication is not enabled.");

    context.header("Cache-Control", "no-store");
    const token = getBearerToken(context);
    if (!token) return unauthorized(context, "VOS access token is required.");

    const vosUser = await verifyVosAccessToken(context.env, token);
    const db = context.env.storage.db;
    const user = await readMappedUser(db, vosUser.subject);
    if (!user || user.is_disabled) {
      throw new AppError("vos_pairing_unavailable", "Open V-Note in VOS with an enabled account before pairing.", 403);
    }

    const pairing = await issueVosMobilePairing(db, user.id);
    return context.json({ username: user.username, ...pairing });
  });

  app.post("/api/v1/auth/vos", async (context) => {
    if (!isVosMode(context.env)) return notFound(context, "VOS authentication is not enabled.");

    const token = getBearerToken(context);
    if (!token) return unauthorized(context, "VOS access token is required.");

    const vosUser = await verifyVosAccessToken(context.env, token);
    const provisioned = await provisionVosUser(
      context.env.storage.db,
      vosUser,
      context.req.header("accept-language"),
    );
    const session = await dependencies.createSession(
      context,
      provisioned.user,
      context.req.header("x-edgeever-device-id"),
    );
    dependencies.setSessionCookie(context, session.token, session.maxAge);

    const now = isoNow();
    await context.env.storage.db.prepare(
      `UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(now, now, provisioned.user.id).run();

    return context.json({
      authRequired: true,
      authenticated: true,
      demoMode: false,
      vosMode: true,
      user: {
        id: provisioned.user.id,
        username: provisioned.user.username,
        displayName: provisioned.user.display_name,
        role: provisioned.role,
      },
    });
  });
};
