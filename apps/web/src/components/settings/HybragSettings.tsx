import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAppBaseUrl } from "@/lib/vos-mode";
import { getVosUserProof } from "../VosAuthGate";
import type { AuthUser } from "@edgeever/shared";

type Notebook = { id: string; parentId: string | null; name: string };
type Schedule = { mode: "manual" | "interval" | "night"; intervalMinutes: number; timeZone: string; nightStart: number; nightEnd: number };
type Settings = { enabled: boolean; roots: string[]; pausedRoots:string[]; version: number; controlPending: boolean; notebooks: Notebook[]; schedule: Schedule; capabilities?:{rootPause?:number} };
type Run = { rootId: string; configVersion: number; state: string; completed: number; skipped: number; failed: number; skippedType: number; skippedResource: number; skippedSize: number; lastError: string };
type BackgroundRun = {rootId:string;configVersion:number;state:string;errorCode?:string};
type Delegation = { state: "active" | "revoking" | "disabled"; targetReady: boolean; settings?: Pick<Settings,"enabled"|"roots"|"pausedRoots"|"version"|"controlPending"|"schedule"|"capabilities"> };

const normalizeSettings=(value:Settings):Settings=>({...value,pausedRoots:value.pausedRoots??[],schedule:value.schedule??{mode:"manual",intervalMinutes:15,timeZone:"UTC",nightStart:0,nightEnd:6}});

const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${getAppBaseUrl()}/api/v1/integrations/hybrag/${path}`, {
    credentials: "include", ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new Error(body?.error?.code || `http_${response.status}`);
  }
  return response.json() as Promise<T>;
};
const post = <T,>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const HybragSettings = ({ user }: { user: AuthUser | null }) => {
  const { t } = useTranslation();
  const [data, setData] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [backgroundRuns,setBackgroundRuns] = useState<BackgroundRun[]>([]);
  const [backgroundStatusFailed,setBackgroundStatusFailed] = useState(false);
  const [delegation,setDelegation] = useState<Delegation | null>(null);
  const [backgroundCapable,setBackgroundCapable] = useState(false);
  const [connection, setConnection] = useState<"checking" | "connected" | "unavailable" | "unbound" | "upgrade">("checking");
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState("");
  const alive = useRef(true);
  const dirtyRef=useRef(false);
  const markDirty=(value:boolean)=>{dirtyRef.current=value;setDirty(value);};
  const refreshDelegation=useCallback(async()=>{
    const result=await request<Delegation>("delegation");
    if(alive.current) {
      setDelegation(result);
      if(result.settings) setData(current=>{
        if(!current || !result.settings) return current;
        if(current.version===result.settings.version) return {...current,controlPending:result.settings.controlPending,capabilities:result.settings.capabilities??current.capabilities};
        return dirtyRef.current?current:{...current,...result.settings};
      });
    }
  },[]);
  const refreshRuns = useCallback(async () => {
    const result = await request<{ runs: Run[] }>("runs");
    if (alive.current) setRuns(result.runs);
  }, []);
  const discover = useCallback(async () => {
    setConnection("checking");
    try {
      const accessToken = await getVosUserProof();
      const capability=await post<{backgroundSync?:number}>("discover", { accessToken });
      if(alive.current) setBackgroundCapable(capability.backgroundSync===1);
      const control = await post<{ pending: boolean }>("deliver-control", { accessToken });
      if (alive.current) { setConnection("connected"); setData((current) => current ? { ...current, controlPending: control.pending } : current); }
    }
    catch (error) { if (alive.current) setConnection(error instanceof Error && error.message === "hybrag_identity_binding_required" ? "unbound" : error instanceof Error && error.message === "hybrag_upgrade_required" ? "upgrade" : "unavailable"); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void request<Settings>("settings").then((value) => { if (alive.current) { setData(normalizeSettings(value)); void discover(); } }).catch(() => { if (alive.current) setMessage("failed"); });
    void refreshRuns().catch(() => {});
    void refreshDelegation().catch(()=>{});
    const timer=window.setInterval(()=>{void refreshDelegation().catch(()=>{});},20000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [discover, refreshRuns,refreshDelegation]);
  useEffect(()=>{
    if(!backgroundCapable||!data?.roots.length)return;
    let active=true;
    const refresh=async()=>{try{
      const result=await post<{runs:BackgroundRun[]}>("background-status",{accessToken:await getVosUserProof()});
      if(active&&alive.current){setBackgroundRuns(result.runs);setBackgroundStatusFailed(false);}
    }catch{if(active&&alive.current)setBackgroundStatusFailed(true);}};
    void refresh();const timer=window.setInterval(()=>void refresh(),20000);
    return()=>{active=false;window.clearInterval(timer);};
  },[backgroundCapable,data?.roots.length]);
  const parents = new Map(data?.notebooks.map((n) => [n.id, n.parentId]) ?? []);
  const overlaps = (a: string, b: string) => {
    const seen = new Set<string>();
    let current: string | null | undefined = a;
    while (current && !seen.has(current)) { if (current === b) return true; seen.add(current); current = parents.get(current); }
    return false;
  };
  const path = (n: Notebook) => {
    const names = [n.name], seen = new Set([n.id]); let parent = n.parentId;
    while (parent && !seen.has(parent)) { seen.add(parent); const node = data?.notebooks.find((item) => item.id === parent); if (!node) break; names.unshift(node.name); parent = node.parentId; }
    return names.join(" / ");
  };
  const save = async () => {
    if (!data) return;
    setBusy(true); setMessage("");
    try {
      const result = await request<{ version: number }>("settings", { method: "PUT", body: JSON.stringify({ enabled: data.enabled, roots: data.roots, pausedRoots:data.pausedRoots.filter(id=>data.roots.includes(id)), version: data.version, schedule:data.schedule }) });
      setData({ ...data, version: result.version, controlPending: true }); markDirty(false); setMessage("saved");
      try {
        if(data.enabled) await post("delegation",{accessToken:await getVosUserProof({fresh:true}),version:result.version,consent:true});
        else await request("delegation",{method:"DELETE"});
        await refreshDelegation();
      } catch { if(alive.current) setMessage("authorizationUnavailable"); }
      try {
        const control = await post<{ pending: boolean }>("deliver-control", { accessToken: await getVosUserProof() });
        if (alive.current) setData((current) => current?.version === result.version ? { ...current, controlPending: control.pending } : current);
      } catch { /* The saved control event remains pending for retry. */ }
      const current=await request<Settings>("settings");
      if(alive.current) setData(normalizeSettings(current));
    } catch (error) { setMessage(error instanceof Error && error.message === "hybrag_settings_conflict" ? "conflict" : "failed"); } finally { setBusy(false); }
  };
  const sync = async (rootId: string) => {
    setRunning(rootId); setMessage("");
    try {
      const previous = runs.find((run) => run.rootId === rootId);
      if (!previous || previous.state !== "running" || previous.configVersion !== data?.version) {
        await post("start", { rootId, accessToken: await getVosUserProof() });
      }
      while (alive.current) {
        try {
          const result = await post<{ state: string }>("step", { rootId, accessToken: await getVosUserProof() });
          await refreshRuns();
          if (result.state === "completed") break;
          if (result.state === "recovery_required") { setMessage("recoveryRequired"); break; }
        } catch (error) {
          if (!(error instanceof Error) || !["hybrag_busy", "hybrag_run_busy"].includes(error.message)) throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
      }
    } catch (error) { if (alive.current) setMessage(error instanceof Error && ["hybrag_model_or_storage", "hybrag_embedding_unavailable"].includes(error.message) ? "model" : error instanceof Error && error.message === "hybrag_identity_binding_required" ? "unbound" : error instanceof Error && ["hybrag_scope_denied", "hybrag_run_unavailable"].includes(error.message) ? "scopeChanged" : "failed"); }
    finally { if (alive.current) { setRunning(""); await refreshRuns().catch(() => {}); } }
  };
  if (!data) return <div className="p-4 text-sm" role="status">{message ? t("hybrag.failed") : t("hybrag.checking")}</div>;
  return <section className="grid gap-4 rounded-xl border border-slate-200 bg-card p-4 text-sm">
    <h2 className="font-semibold">{t("hybrag.title")}</h2>
    {user && <p>{t("hybrag.currentUser", { name: user.displayName || user.username })}</p>}
    <div role="status">{t(`hybrag.${connection}`)} {connection !== "checking" && connection !== "connected" && <Button variant="outline" size="sm" onClick={() => void discover()}>{t("hybrag.retry")}</Button>}</div>
    {connection==="connected"&&!backgroundCapable&&<p role="status">{t("hybrag.automaticUpgrade")}</p>}
    <a
      className="underline"
      href="/app/com.ictrek.hybrag/platform/knowledge-bases"
      target="_blank"
      rel="noreferrer"
      onClick={async (event) => {
        const platform = window.vos_platform?.platform;
        if (!platform?.openTab || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const fallback = event.currentTarget.href;
        event.preventDefault();
        try {
          await platform.openTab({ app: { id: "com.ictrek.hybrag", page: "hybrag" } });
        } catch (error) {
          if ((error as { name?: string } | null)?.name !== "PlatformNotAuthenticatedError") {
            window.location.assign(fallback);
          }
        }
      }}
    >{t("hybrag.source")}</a>
    <div className="flex items-center gap-3"><Switch checked={data.enabled} disabled={busy} onCheckedChange={(enabled) => { setData({ ...data, enabled }); markDirty(true); }} aria-label={t("hybrag.enabled")} /><span>{t("hybrag.enabled")}</span></div>
    <p className="text-slate-500">{t("hybrag.description")}</p>
    {data.enabled&&<p className="text-slate-500">{t("hybrag.backgroundConsent")}</p>}
    {delegation&&<p role="status">{t(delegation.state==="revoking"?"hybrag.authorizationRevoking":delegation.state==="active"?(delegation.targetReady?"hybrag.authorizationActive":"hybrag.authorizationPending"):"hybrag.authorizationDisabled")}</p>}
    <div className="grid gap-2">
      <label htmlFor="hybrag-schedule" className="font-medium">{t("hybrag.schedule")}</label>
      <Select value={data.schedule.mode} disabled={busy} onValueChange={(mode: Schedule["mode"])=>{markDirty(true);setData({...data,schedule:{...data.schedule,mode,...(mode==="night"?{timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}:{})}});}}>
        <SelectTrigger id="hybrag-schedule"><SelectValue /></SelectTrigger>
        <SelectContent>{(["interval","night","manual"] as const).map(mode=><SelectItem key={mode} value={mode}>{t(`hybrag.schedule_${mode}`)}</SelectItem>)}</SelectContent>
      </Select>
      {data.schedule.mode!=="manual"&&<>
        <label htmlFor="hybrag-interval">{t("hybrag.interval")}</label>
        <Select value={String(data.schedule.intervalMinutes)} disabled={busy} onValueChange={(value)=>{markDirty(true);setData({...data,schedule:{...data.schedule,intervalMinutes:Number(value)}});}}>
          <SelectTrigger id="hybrag-interval"><SelectValue /></SelectTrigger>
          <SelectContent>{[15,30,60,240].map(minutes=><SelectItem key={minutes} value={String(minutes)}>{t("hybrag.minutes",{count:minutes})}</SelectItem>)}</SelectContent>
        </Select>
      </>}
      {data.schedule.mode==="night"&&<>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1">{t("hybrag.nightStart")}<Input type="number" min={0} max={23} value={data.schedule.nightStart} disabled={busy} onChange={(e)=>{markDirty(true);setData({...data,schedule:{...data.schedule,nightStart:Number(e.target.value)}});}} /></label>
          <label className="grid gap-1">{t("hybrag.nightEnd")}<Input type="number" min={0} max={23} value={data.schedule.nightEnd} disabled={busy} onChange={(e)=>{markDirty(true);setData({...data,schedule:{...data.schedule,nightEnd:Number(e.target.value)}});}} /></label>
        </div>
        <p className="text-slate-500">{t("hybrag.nightZone",{zone:data.schedule.timeZone})}</p>
      </>}
      <p className="text-slate-500">{t("hybrag.scheduleHelp")}</p>
    </div>
    <fieldset className="grid gap-2"><legend className="mb-2 font-medium">{t("hybrag.notebooks")}</legend>
      {data.notebooks.map((n) => <label key={n.id} className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked={data.roots.includes(n.id)} onChange={(event) => {
        if (event.target.checked && data.roots.some((root) => overlaps(root, n.id) || overlaps(n.id, root))) { setMessage("overlap"); return; }
        setMessage(""); markDirty(true); setData({ ...data, roots: event.target.checked ? [...data.roots, n.id] : data.roots.filter((id) => id !== n.id) });
      }} /><span>{path(n)}</span></label>)}
      {data.roots.filter((id) => !parents.has(id)).map((id) => <label key={id} className="flex items-center gap-2"><input type="checkbox" disabled={busy} checked onChange={() => { markDirty(true); setData({ ...data, roots: data.roots.filter((root) => root !== id) }); }} /><span>{t("hybrag.missingRoot")}</span></label>)}
    </fieldset>
    <div><Button onClick={() => void save()} disabled={busy || (data.enabled && !data.roots.length)}>{t(busy ? "hybrag.saving" : "hybrag.save")}</Button></div>
    <p className="text-slate-500">{t("hybrag.manual")}</p><p className="text-slate-500">{t("hybrag.caveat")}</p>
    {dirty && <p role="status">{t("hybrag.unsaved")}</p>}
    {data.controlPending && <p role="status">{t("hybrag.controlPending")} <Button variant="outline" size="sm" onClick={() => void discover()}>{t("hybrag.retry")}</Button></p>}
    {data.roots.map((root) => {
      const run = runs.find((item) => item.rootId === root);
      const background=backgroundRuns.find(row=>row.rootId===root&&row.configVersion===data.version);
      const needsRecovery=backgroundRuns.some(row=>row.rootId===root&&row.errorCode==="recovery_required");
      const backgroundState=data.pausedRoots.includes(root)?"paused":backgroundStatusFailed?"unavailable":background&&["scanning","pending","indexing","waiting","attention","unavailable"].includes(background.state)?background.state:"pending";
      return <div key={root} className="grid gap-1 border-t pt-3">
      <div className="font-medium">{data.notebooks.find((item) => item.id === root)?.name ?? t("hybrag.missingRoot")}</div>
      {needsRecovery&&<p role="status">{t("hybrag.recoveryRequired")}</p>}
      {!dirty&&background?.errorCode==="knowledge_base_unavailable"&&<p role="status">{t("hybrag.model")}</p>}
      {data.capabilities?.rootPause===1&&<div><Button variant="outline" size="sm" disabled={busy||!data.enabled} onClick={()=>{markDirty(true);setData({...data,pausedRoots:data.pausedRoots.includes(root)?data.pausedRoots.filter(id=>id!==root):[...data.pausedRoots,root]});}}>{t(data.pausedRoots.includes(root)?"hybrag.resumeRoot":"hybrag.pauseRoot")}</Button></div>}
      {data.pausedRoots.includes(root)&&<p role="status">{t("hybrag.pauseHelp")}</p>}
      {backgroundCapable&&data.enabled&&!dirty&&data.schedule.mode!=="manual"&&<p role="status">{t(`hybrag.auto_${backgroundState}`)}</p>}
      {run && <div>{t("hybrag.progress", run)} · {t(run.state === "completed" ? "hybrag.complete" : "hybrag.inProgress")}</div>}
      {run && run.skipped > 0 && <div>{t("hybrag.skipReasons", run)}</div>}
      {run?.lastError && <div>{t(["hybrag_model_or_storage", "hybrag_embedding_unavailable"].includes(run.lastError) ? "hybrag.model" : ["hybrag_recovery_required", "hybrag_delivery_uncertain"].includes(run.lastError) ? "hybrag.recoveryRequired" : "hybrag.failed")}</div>}
      <div><Button variant="outline" size="sm" disabled={!data.enabled || !parents.has(root) || data.pausedRoots.includes(root) || dirty || data.controlPending || connection !== "connected" || busy || Boolean(running) || delegation?.state==="revoking" || (delegation?.state==="active"&&!delegation.targetReady)} onClick={() => void sync(root)}>{t(running === root ? "hybrag.syncing" : "hybrag.sync")}</Button></div>
    </div>; })}
    {message && <p role="status">{t(`hybrag.${message}`)}</p>}
  </section>;
};
