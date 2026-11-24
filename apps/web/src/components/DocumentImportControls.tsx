import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAppBaseUrl } from "@/lib/vos-mode";
import { getVosUserProof } from "./VosAuthGate";

type ImportJob = {
  id: string;
  notebookId: string;
  filename: string;
  state: "queued" | "processing" | "completed" | "failed";
  errorCode: string | null;
  memoId: string | null;
  pagesDone: number | null;
  pagesTotal: number | null;
};

type ImportJobs = { imports: ImportJob[] };

const route = "/api/v1/integrations/hybrag/document-imports";

async function request<T>(suffix = "", init?: RequestInit): Promise<T> {
  const response = await fetch(getAppBaseUrl() + route + suffix, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new Error(error?.error?.code ?? (response.status === 413 ? "document_too_large" : "unknown"));
  }
  return response.json();
}

export function DocumentImportControls({ notebookId, scope, onOpenMemo }: {
  notebookId: string | null;
  scope: string;
  onOpenMemo: (memoId: string, notebookId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const jobsKey = ["document-imports", scope] as const;
  const cacheJob = (job: ImportJob) => queryClient.setQueryData<ImportJobs>(jobsKey, (previous) => {
    if (!previous) return { imports: [job] };
    return {
      imports: previous.imports.some((item) => item.id === job.id)
        ? previous.imports.map((item) => item.id === job.id ? job : item)
        : [job, ...previous.imports],
    };
  });
  const jobs = useQuery({
    queryKey: jobsKey,
    enabled: open || active !== null,
    queryFn: () => request<{ imports: ImportJob[] }>(),
    refetchInterval: (query) => active || query.state.data?.imports.some((job) => job.state === "queued" || job.state === "processing") ? 3000 : false,
  });
  const current = jobs.data?.imports.find((job) => job.id === active);
  useEffect(() => {
    if (current?.state === "completed" && current.memoId) {
      setActive(null);
      setOpen(false);
      onOpenMemo(current.memoId, current.notebookId);
    } else if (current?.state === "failed") {
      setActive(null);
    }
  }, [current, onOpenMemo]);

  const start = async (file: File, target: string) => {
    setOpen(true);
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.set("id", crypto.randomUUID());
      form.set("notebookId", target);
      form.set("file", file);
      form.set("proof", await getVosUserProof());
      const result = await request<{ import: ImportJob }>("", { method: "POST", body: form });
      if (result.import.state !== "failed") {
        setActive(result.import.id);
        cacheJob(result.import);
      }
      await jobs.refetch();
    } catch (error) {
      setError(error instanceof Error ? error.message : "unknown");
      void jobs.refetch();
    } finally {
      setBusy(false);
    }
  };

  const retry = async (job: ImportJob) => {
    setError("");
    setBusy(true);
    try {
      const { import: result } = await request<{ import: ImportJob }>(`/${job.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof: await getVosUserProof() }),
      });
      if (result.state !== "failed") {
        setActive(result.id);
        cacheJob(result);
      }
      await jobs.refetch();
    } catch (error) {
      setError(error instanceof Error ? error.message : "unknown");
    } finally {
      setBusy(false);
    }
  };

  const errorMessage = (code: string) => t(`documentImport.errors.${code}`, {
    defaultValue: t("documentImport.errors.unknown"),
  });

  return (
    <div className="flex shrink-0 flex-wrap gap-1 border-b border-slate-200 px-3 py-1.5">
      <input
        ref={input}
        type="file"
        accept=".docx,.xlsx,.pptx,.pdf"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && notebookId) void start(file, notebookId);
        }}
      />
      <Button size="sm" variant="ghost" disabled={!notebookId || busy} onClick={() => input.current?.click()}>
        <FileUp className="h-4 w-4" />
        {t("documentImport.action")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <History className="h-4 w-4" />
        {t("documentImport.history")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle>{t("documentImport.history")}</DialogTitle>
            <DialogDescription>{t("documentImport.background")}</DialogDescription>
          </DialogHeader>
          {busy && <p role="status" className="text-sm">{t("documentImport.uploading")}</p>}
          {error && <p role="alert" className="text-sm text-rose-700">{errorMessage(error)}</p>}
          {jobs.isError && <p role="alert" className="text-sm text-rose-700">{errorMessage("unknown")}</p>}
          {!jobs.isPending && !jobs.data?.imports.length && !jobs.isError && (
            <p className="text-sm text-slate-500">{t("documentImport.empty")}</p>
          )}
          <ul className="max-h-[55vh] divide-y divide-slate-200 overflow-y-auto">
            {jobs.data?.imports.map((job) => (
              <li key={job.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{job.filename}</p>
                  <p className="text-xs text-slate-500">
                    {job.errorCode ? errorMessage(job.errorCode)
                      : job.state === "processing" && job.pagesTotal
                        ? t("documentImport.ocrProgress", { done: job.pagesDone ?? 0, total: job.pagesTotal })
                        : t(`documentImport.states.${job.state}`)}
                  </p>
                </div>
                {job.state === "failed" && job.errorCode !== "document_source_missing" && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retry(job)}>
                    {t("documentImport.retry")}
                  </Button>
                )}
                {job.state === "completed" && job.memoId && (
                  <Button size="sm" variant="ghost" onClick={() => {
                    setOpen(false);
                    onOpenMemo(job.memoId!, job.notebookId);
                  }}>
                    {t("documentImport.open")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
