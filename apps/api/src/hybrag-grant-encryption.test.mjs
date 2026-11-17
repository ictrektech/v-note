import { expect, test } from "bun:test";
import { decryptHybragGrant, encryptHybragGrant } from "./hybrag-grant-encryption.ts";

test("encrypted grants are bound to the exact owner and support key rotation", async () => {
  const owner = { userId: "u", workspaceId: "w", subject: "subject" };
  const oldEnv = { EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY: "old-key" };
  const secret = "a".repeat(64);
  const encrypted = await encryptHybragGrant(secret, owner, oldEnv);
  expect(encrypted).not.toContain(secret);
  expect(await decryptHybragGrant(encrypted, owner, { EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY: "new-key", EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: "old-key" })).toBe(secret);
  await expect(decryptHybragGrant(encrypted, { ...owner, subject: "other" }, oldEnv)).rejects.toThrow();
  await expect(decryptHybragGrant(encrypted, owner, { EDGE_EVER_CREDENTIALS_ENCRYPTION_KEY: "lost" })).rejects.toThrow();
  await expect(encryptHybragGrant(secret, owner, {})).rejects.toThrow();
});
