import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prefersChineseContent } from "@/lib/bilingual-content-locale";
import { getAppBaseUrl } from "@/lib/vos-mode";
import { getVosAccessToken } from "../VosAuthGate";
import { copyTextToClipboard } from "./settings-utils";

type Pairing = { username: string; code: string; expiresAt: string };

export const VosMobilePairingCard = () => {
  const { i18n } = useTranslation();
  const zh = prefersChineseContent(i18n.resolvedLanguage);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const base = getAppBaseUrl();
  const lanUrl = new URL(base);
  lanUrl.protocol = "http:";
  lanUrl.port = "22710";
  lanUrl.pathname = "/";
  const lan = lanUrl.origin;

  const generate = async () => {
    setBusy(true);
    setStatus("");
    setPairing(null);
    try {
      const accessToken = await getVosAccessToken();
      const response = await fetch(`${base}/api/v1/auth/vos/pairing`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error("Pairing failed");
      setPairing(await response.json() as Pairing);
    } catch {
      setStatus(zh ? "无法生成配对码。请从 VOS 重新打开 V-Note 后重试。" : "Could not generate a code. Reopen V-Note from VOS and try again.");
    } finally {
      setBusy(false);
    }
  };

  const fields = [
    [zh ? "服务器地址（HTTPS）" : "Server URL (HTTPS)", base],
    [zh ? "服务器地址（可信局域网）" : "Server URL (trusted LAN)", lan],
    ...(pairing ? [
      [zh ? "用户名" : "Username", pairing.username],
      [zh ? "一次性配对码（填入密码栏）" : "One-time code (enter in Password)", pairing.code],
    ] : []),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{zh ? "连接 EdgeEver 原生 App" : "Connect the EdgeEver app"}</CardTitle>
        <CardDescription>
          {zh ? "使用配对码登录 iOS 或 Android App，即可同步当前 VOS 账号的笔记。"
              : "Sign in to EdgeEver on iOS or Android with a pairing code to sync notes from your current VOS account."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>{zh ? "优先使用证书受手机信任的 HTTPS 地址。在可信局域网内，也可用下方的直连地址。选一个填到 App 的服务器地址栏。"
          : "Use the HTTPS URL if your phone trusts its certificate. On a trusted LAN, you can use the direct URL below. Enter one URL in the app."}</p>
        <dl className="space-y-3">
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt className="font-medium">{label}</dt>
              <dd className="flex items-center justify-between gap-2">
                <code className="min-w-0 break-all">{value}</code>
                <Button size="sm" variant="outline" aria-label={`${zh ? "复制" : "Copy"} ${label}`}
                  onClick={async () => setStatus(await copyTextToClipboard(value)
                    ? (zh ? "已复制" : "Copied")
                    : (zh ? "复制失败，请手动选中文本。" : "Copy failed. Select the text to copy it."))}>
                  {zh ? "复制" : "Copy"}
                </Button>
              </dd>
            </div>
          ))}
        </dl>
        <p>{zh ? "配对码五分钟内可用一次。生成新配对码会使旧码失效。"
          : "The code works once within five minutes. Generating a new code cancels the previous one."}</p>
        {pairing && <p>{zh ? "到期时间：" : "Expires: "}{new Date(pairing.expiresAt).toLocaleTimeString(i18n.resolvedLanguage)}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => void generate()}>
            {busy ? (zh ? "正在生成…" : "Generating…") : (zh ? "生成配对码" : "Generate pairing code")}
          </Button>
          <Link to="/api-guide" className="underline">{zh ? "API 接入指南" : "API Guide"}</Link>
        </div>
        <p role="status">{status}</p>
      </CardContent>
    </Card>
  );
};
