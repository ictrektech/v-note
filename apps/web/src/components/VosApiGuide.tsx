import { useMemo } from "react";
import { BookOpen } from "lucide-react";
import { marked } from "marked";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { prefersChineseContent } from "@/lib/bilingual-content-locale";
import { getAppBaseUrl } from "@/lib/vos-mode";
import { MCP_TOOLS } from "../../../api/src/mcp-tools";
import english from "../../../../docs/vos-api-guide.md?raw";
import chinese from "../../../../docs/vos-api-guide.zh-CN.md?raw";

export const VosApiGuide = () => {
  const { i18n } = useTranslation();
  const zh = prefersChineseContent(i18n.resolvedLanguage);
  // Only checked-in documentation is rendered as HTML. The current URL is rendered as text.
  const html = useMemo(() => marked.parse(zh ? chinese : english, { async: false }), [zh]);

  return (
    <div className="h-[100dvh] overflow-y-auto bg-workspace-canvas">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-3 sm:px-6">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <BookOpen aria-hidden="true" className="h-5 w-5" />
          {zh ? "V-Note API 接入指南" : "V-Note API Guide"}
        </h1>
        <Button asChild size="sm" variant="outline">
          <Link to="/settings?tab=mcp">{zh ? "API / MCP 设置" : "API / MCP settings"}</Link>
        </Button>
      </header>
      <main className="mx-auto max-w-5xl min-w-0 space-y-5 px-4 py-5 sm:px-6">
        <section className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">{zh ? "当前实例的 MCP 地址" : "MCP endpoint for this instance"}</h2>
          <code className="mt-2 block break-all text-sm">{getAppBaseUrl()}/mcp</code>
        </section>
        <article className="markdown-content max-w-none overflow-x-auto rounded-lg border bg-card p-4 sm:p-7" dangerouslySetInnerHTML={{ __html: html }} />
        <section className="space-y-3 rounded-lg border bg-card p-4 sm:p-7">
          <h2 className="text-lg font-semibold">{zh ? "MCP 工具目录" : "MCP tool catalog"}</h2>
          <p className="text-sm text-muted-foreground">
            {zh ? "展开工具可查看随当前版本生成的输入约束和行为注解。" : "Expand a tool to see the input constraints and behavior annotations for this build."}
          </p>
          {MCP_TOOLS.map(({ name, description, inputSchema, outputSchema, annotations }) => (
            <details key={name} className="rounded-md border p-3">
              <summary className="cursor-pointer break-all font-mono text-sm">{name}</summary>
              <p className="mt-2 text-sm">{description}</p>
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
                {JSON.stringify({ inputSchema, outputSchema, annotations }, null, 2)}
              </pre>
            </details>
          ))}
        </section>
      </main>
    </div>
  );
};
