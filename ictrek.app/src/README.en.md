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

## MCP and mobile clients

Open **API Guide** beside **V-Note** in the VOS App Drawer, or from **Profile → API / MCP → API Guide**. Use `https://<vos-host>:1180/app/com.ictrek.v-note/mcp` with a V-Note Bearer API token. The package already maps direct LAN HTTP `22710` to container `8787`. In EdgeEver, enter the V-Note HTTPS gateway URL and your own VOS username and password to open your existing workspace. No pairing or extra port mapping is needed. See the in-app guide for downloads, certificate setup and API contracts.

## Source

This application is adapted from EdgeEver (AGPL-3.0). The public fork is https://github.com/ictrektech/v-note.
