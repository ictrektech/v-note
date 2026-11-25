# V-Note

V-Note is an AI knowledge base and notes workspace for VOS, adapted from EdgeEver.

## Usage

- Open V-Note from the VOS application drawer. The current VOS user signs in automatically.
- If the browser workspace cannot verify your V-Note session, choose **Retry** to sign in again through VOS. The sign-in API is unchanged.
- The interface theme follows VOS by default. Choose Light or Dark under Profile → General to override it.
- When the interface language is set to “Follow system (VOS)”, it follows the platform language; you can also choose a language manually in Settings.
- Every VOS user gets an isolated personal workspace. VOS administrators can manage instance users and storage, but cannot read other users' notes.
- Notes, attachments, full-text search, templates, BYOK AI, and MCP/API tokens are supported.
- Anonymous note sharing, public notebook publishing, and public collection forms are disabled in the VOS build.
- New users do not receive upstream example notes automatically. Existing examples are retained, but their public publishing instructions do not apply to the VOS build.

## AI

Configure a reachable OpenAI-compatible endpoint in Settings. V-Scheduler is
optional and no model is bundled. Its endpoint and browser accessibility depend
on the deployment and must be verified.

## Data and recovery

- Data lives under the application storage `data/` directory. Preserve it when uninstalling.
- Use Import & Export to create regular ZIP backups.
- For a local break-glass administrator, set `VNOTE_BREAK_GLASS_PASSWORD` during installation and open
  `/app/com.ictrek.v-note/?local=1`. Normal users do not need this path.

## MCP and mobile clients

In VOS, open **Application Management → App Drawer → V-Note → API Guide**. You can also open it from **Profile → API / MCP → API Guide**. Use `https://<vos-host>:1180/app/com.ictrek.v-note/mcp` with a V-Note Bearer API token. The package already maps direct LAN HTTP `22710` to container `8787`. In EdgeEver, enter the V-Note HTTPS gateway URL and your own VOS username and password to open your existing workspace. New V-Note sessions last 180 days by default. See the in-app guide for downloads, certificate setup and API contracts.

## Source

This application is adapted from EdgeEver (AGPL-3.0). The public fork is https://github.com/ictrektech/v-note.

### Import Office and PDF as editable notes

In the VOS Web workspace, select a notebook and click **Import Office / PDF** above its note list. Choose one DOCX, XLSX, PPTX or PDF file. Open **Import history** to check progress, retry a failure, or open the result. Conversion continues after you close the page. V-Note saves the extracted text, headings, lists, tables and supported images in a normal note and includes the original as a downloadable attachment. Use the original to check layout, spreadsheet formulas or slide positioning.

Install a compatible HybRAG on the same VOS device and associate the same VOS account in HybRAG. Scanned PDFs use the associated tenant's configured OCR parser or default vision model. If the tenant uses a cloud OCR service, document data may be sent to that service. The per-file limit is 100 MiB or a lower limit imposed by the deployment. The chat attachment eight-page OCR limit does not apply. If a scanned page cannot be recognized, the import reports a failure. Update the OCR configuration or correct the file before retrying. Import needs neither a knowledge base nor an embedding model.

The import endpoints are private VOS Web and app-to-app contracts. The existing public HTTP API and MCP still support reading and editing the resulting regular note and its resources with the applicable scopes.
