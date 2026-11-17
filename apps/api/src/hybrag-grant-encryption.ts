import type { Bindings } from "./api-context";
import { AppError } from "./app-error";
import { decryptSecret, encryptSecret } from "./secret-encryption";

type Environment = Pick<Bindings, "EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY" | "EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS">;
type Owner = { userId: string; workspaceId: string; subject: string };
const keys = (env: Environment, owner: Owner) => [env.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY, env.EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS]
  .flatMap((key) => key?.trim() ? [JSON.stringify(["edgeever:hybrag-grant:v1", owner.userId, owner.workspaceId, owner.subject, key.trim()])] : []);

export const encryptHybragGrant = async (secret: string, owner: Owner, env: Environment) => {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new AppError("hybrag_grant_invalid", "The VOS grant is invalid.", 503);
  const key = keys({ ...env, EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: undefined }, owner)[0];
  if (!key) throw new AppError("hybrag_encryption_unavailable", "Configure a credential encryption key before enabling background synchronization.", 503);
  return encryptSecret(secret, key);
};

export const decryptHybragGrant = async (encrypted: string, owner: Owner, env: Environment) => {
  for (const key of keys(env, owner)) {
    try {
      const value = await decryptSecret(encrypted, key);
      if (/^[0-9a-f]{64}$/.test(value)) return value;
    } catch { /* A rotated or incorrect key is never an authorization success. */ }
  }
  throw new AppError("hybrag_encryption_unavailable", "The saved integration credential cannot be decrypted.", 503);
};
