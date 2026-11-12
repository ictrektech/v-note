import { useEffect, useState, type ReactNode } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { getAppBaseUrl, isVosBuild, isVosLocalLogin, VOS_APP_ID } from "@/lib/vos-mode";
import { getOrCreateClientDeviceId } from "@/lib/api";

type VosOAuth = {
  authorize: (input: Record<string, string>) => Promise<{ code: string; state: string }>;
  token: (input: Record<string, string>) => Promise<{ access_token: string; expires_in?: number }>;
};

type VosPlatform = {
  api?: { v1000?: { oauth2?: VosOAuth } };
  getState?: () => Promise<{ locale?: unknown }>;
  broadcast?: {
    on: {
      (event: "user-change", listener: (state: { user: unknown }) => void): () => void;
      (event: "locale-change", listener: (state: { locale?: unknown }) => void): () => void;
    };
  };
};

declare global {
  interface Window {
    vos_platform?: VosPlatform;
  }
}

const waitForVosPlatform = async (timeoutMs = 3000): Promise<VosPlatform | null> => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (window.vos_platform?.api?.v1000?.oauth2) return window.vos_platform;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return window.vos_platform?.api?.v1000?.oauth2 ? window.vos_platform : null;
};

const base64url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomValue = (bytes: number) => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return value;
};

export const getVosAccessToken = async (platform: VosPlatform | null = window.vos_platform ?? null) => {
  const oauth = platform?.api?.v1000?.oauth2;
  if (!oauth) {
    throw new Error("Please open V-Note from VOS / 请从 VOS 打开 V-Note");
  }

  const verifier = base64url(randomValue(32));
  const state = base64url(randomValue(24));
  const nonce = base64url(randomValue(24));
  const challenge = base64url(sha256(new TextEncoder().encode(verifier)));
  const authorization = await oauth.authorize({
    client_id: VOS_APP_ID,
    response_type: "code",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (authorization.state !== state || !authorization.code) {
    throw new Error("VOS OIDC state mismatch");
  }
  const tokens = await oauth.token({
    grant_type: "authorization_code",
    client_id: VOS_APP_ID,
    code: authorization.code,
    code_verifier: verifier,
  });
  if (!tokens.access_token) throw new Error("VOS access token missing");
  return tokens.access_token;
};

const errorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/PlatformNotAuthenticated/i.test(message)) return "请先登录 VOS，然后重试。";
  if (/VOS sign-in/i.test(message)) return "VOS 登录失败，请重新打开应用。";
  return message || "VOS 登录失败";
};

/** VOS hosts inject this bridge only for same-origin iframe applications. */
export const VosAuthGate = ({ children }: { children: ReactNode }) => {
  const [ready, setReady] = useState(() => !isVosBuild || isVosLocalLogin());
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isVosBuild || isVosLocalLogin()) return;
    let active = true;
    let stopUserChange: (() => void) | undefined;
    setError(null);
    setReady(false);

    void (async () => {
      const platform = await waitForVosPlatform();
      const accessToken = await getVosAccessToken(platform);

      const response = await fetch(`${getAppBaseUrl()}/api/v1/auth/vos`, {
        method: "POST",
        credentials: "include",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-edgeever-device-id": getOrCreateClientDeviceId(),
        },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message || "VOS sign-in was rejected");
      }
      if (!active) return;
      stopUserChange = platform?.broadcast?.on("user-change", () => {
        // Re-run the VOS exchange against the new platform user. A reload also
        // clears any stale EdgeEver session cookie through the backend.
        window.location.reload();
      });
      setReady(true);
    })().catch((reason) => {
      if (!active) return;
      setError(errorMessage(reason));
    });

    return () => {
      active = false;
      stopUserChange?.();
    };
  }, [attempt]);

  if (ready) return children;

  return (
    <main className="flex h-[100dvh] items-center justify-center bg-slate-50 px-6 text-center text-slate-700">
      <div role={error ? "alert" : "status"} aria-live="polite" className="max-w-md">
        <h1 className="text-sm font-semibold">{error ? "无法登录 V-Note" : "正在通过 VOS 登录 V-Note"}</h1>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {error || "正在校验 VOS 身份，请稍候…"}
        </p>
        {error ? (
          <button
            type="button"
            className="mt-5 rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </button>
        ) : null}
      </div>
    </main>
  );
};
