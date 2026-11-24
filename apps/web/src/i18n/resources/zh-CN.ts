import { zhCN as shared } from "@edgeever/shared/i18n/zh-CN";

export const zhCN = {
  ...shared,
  documentImport: {
    action: "导入 Office／PDF",
    history: "导入记录",
    background: "离开页面后，转换仍会在后台继续。",
    uploading: "正在上传…",
    empty: "暂无文档导入记录。",
    retry: "重试",
    open: "打开笔记",
    ocrProgress: "正在识别扫描页（{{done}}／{{total}}）",
    states: { queued: "排队中", processing: "转换中", completed: "已完成", failed: "失败" },
    errors: {
      unknown: "导入未完成，请重试。",
      document_service_upgrade_required: "请安装或升级到支持文档导入的 HybRAG 版本。",
      document_identity_binding_required: "请在 HybRAG 关联 VOS 账号后重试。",
      document_service_access_denied: "请登录 VOS 并确认已关联 HybRAG 账号。",
      document_service_unavailable: "HybRAG 暂不可用。请确认服务正在运行后重试。",
      document_notebook_unavailable: "目标笔记本已不可用。",
      document_too_large: "请选择非空且未超过部署上传限制的文件，最大 100 MiB。",
      document_unsupported_type: "请选择 DOCX、XLSX、PPTX 或 PDF 文件。",
      document_parse_failed: "HybRAG 无法读取此文档。",
      document_ocr_unavailable: "请在 HybRAG 配置 OCR 引擎或默认视觉模型后重试。",
      document_ocr_failed: "HybRAG 未能识别全部扫描页。",
      document_empty: "此文档没有可导入的文本。",
      document_source_missing: "上传文件已不可用，请重新选择原文件。",
      document_result_expired: "转换结果已过期，请重试。",
    },
  },
} as const;
