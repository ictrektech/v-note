import { randomToken } from "./auth-crypto";
import { sha256 } from "./hash-utils";
import type { DatabaseAdapter } from "./storage-contract";

const PREFIX = "vnote-";
const TTL_MS = 5 * 60 * 1000;

export const isVosMobilePairingCode = (value: string) => value.startsWith(PREFIX);

export const issueVosMobilePairing = async (db: DatabaseAdapter, userId: string) => {
  const code = PREFIX + randomToken(24);
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  await db.prepare(
    `INSERT INTO vos_mobile_pairings (user_id, code_hash, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
  ).bind(userId, await sha256(code), expiresAt).run();
  return { code, expiresAt };
};

export const consumeVosMobilePairing = async (db: DatabaseAdapter, userId: string, code: string) =>
  Boolean(await db.prepare(
    `DELETE FROM vos_mobile_pairings WHERE user_id = ? AND code_hash = ? AND expires_at > ?
     RETURNING user_id`,
  ).bind(userId, await sha256(code), new Date().toISOString()).first());
