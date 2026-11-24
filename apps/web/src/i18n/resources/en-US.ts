import { enUS as shared } from "@edgeever/shared/i18n/en-US";

export const enUS = {
  ...shared,
  documentImport: {
    action: "Import Office / PDF",
    history: "Import history",
    background: "Conversion continues in the background after you leave.",
    uploading: "Uploading…",
    empty: "No document imports yet.",
    retry: "Retry",
    open: "Open note",
    ocrProgress: "Recognizing scanned pages ({{done}} / {{total}})",
    states: { queued: "Queued", processing: "Converting", completed: "Completed", failed: "Failed" },
    errors: {
      unknown: "Could not complete the import. Try again.",
      document_service_upgrade_required: "Install or upgrade HybRAG to a version that supports document import.",
      document_identity_binding_required: "Associate your VOS account in HybRAG, then retry.",
      document_service_access_denied: "Sign in to VOS and confirm your HybRAG account association.",
      document_service_unavailable: "HybRAG is unavailable. Check that it is running, then retry.",
      document_notebook_unavailable: "The destination notebook is no longer available.",
      document_too_large: "Choose a non-empty file within the deployment's upload limit (up to 100 MiB).",
      document_unsupported_type: "Choose a DOCX, XLSX, PPTX or PDF file.",
      document_parse_failed: "HybRAG could not read this document.",
      document_ocr_unavailable: "Configure OCR or a default vision model in HybRAG, then retry.",
      document_ocr_failed: "HybRAG could not recognize every scanned page.",
      document_empty: "The document did not contain importable text.",
      document_source_missing: "The uploaded file is unavailable. Select the original file again.",
      document_result_expired: "The conversion result expired. Retry to convert it again.",
    },
  },
} as const;
