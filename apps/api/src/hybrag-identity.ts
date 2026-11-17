import type { AppContext } from "./api-context";
import { AppError } from "./app-error";
import { verifyVosAccessToken } from "./vos-auth";
import { isVosMode } from "./vos-mode";
import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "./api-context";
import { bodyLimit } from "hono/body-limit";

export const verifyHybragSessionIdentity = async (context: AppContext, accessToken: string) => {
  const auth = context.get("auth");
  if (!isVosMode(context.env) || auth?.kind !== "user" || !auth.actorId || !auth.sessionId || auth.mfaRestricted) {
    throw new AppError("hybrag_user_session_required", "A signed-in VOS user is required.", 403);
  }
  if (!accessToken || accessToken.length > 16384 || /[\r\n]/.test(accessToken)) {
    throw new AppError("hybrag_vos_proof_required", "A current VOS user token is required.", 401);
  }
  const binding = await context.env.storage.db.prepare(
    `SELECT i.subject FROM user_identities i
     INNER JOIN users u ON u.id = i.user_id AND u.is_disabled = 0
     INNER JOIN workspace_members m ON m.user_id = u.id
     INNER JOIN workspaces w ON w.id = m.workspace_id AND w.is_personal = 1 AND m.role = 'owner'
       AND NOT EXISTS (SELECT 1 FROM workspace_members peers WHERE peers.workspace_id=w.id AND peers.user_id<>u.id)
     WHERE i.provider = 'vos' AND i.user_id = ? AND m.workspace_id = ?`,
  ).bind(auth.actorId, auth.workspaceId).first<{ subject: string }>();
  if (!binding) {
    throw new AppError("hybrag_identity_unbound", "This session is not bound to a personal VOS workspace.", 403);
  }
  const user = await verifyVosAccessToken(context.env, accessToken, { requireHuman: true });
  if (binding.subject !== user.subject) {
    throw new AppError("hybrag_identity_mismatch", "The VOS user does not match this V-Note session.", 403);
  }
  return { subject: user.subject, userId: auth.actorId, workspaceId: auth.workspaceId };
};

export const registerHybragIdentityRoutes = (app: Hono<AppEnv>) => {
  app.post(
    "/api/v1/integrations/hybrag/identity",
    bodyLimit({ maxSize: 32768 }),
    zValidator("json", z.object({ accessToken: z.string().min(1).max(16384) })),
    async (context) => {
      context.header("Cache-Control", "no-store");
      const identity = await verifyHybragSessionIdentity(context, context.req.valid("json").accessToken);
      return context.json({ verified: true, identity });
    },
  );
};
