# V-Note

V-Note is an AI knowledge base and notes workspace for VOS, adapted from EdgeEver.

## Usage

- Open V-Note from the VOS application drawer. The current VOS user signs in automatically.
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

## MCP

Create a token under Settings → MCP. The remote MCP endpoint is
`http://<vos-host>/app/com.ictrek.v-note/mcp`.

## Source

This application is adapted from EdgeEver (AGPL-3.0). The public fork is https://github.com/ictrektech/v-note.
