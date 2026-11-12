## Choose the connection

| Client | Base URL or endpoint | Authentication |
| --- | --- | --- |
| VOS browser | Open V-Note from the VOS App Drawer. The gateway mounts it at `https://<vos-host>:1180/app/com.ictrek.v-note`. Use the scheme, host and port of your own VOS gateway. | VOS signs in the current user using the embedded application bridge and OIDC. |
| External MCP client | Recommended `https://<vos-host>:1180/app/com.ictrek.v-note/mcp`. In a trusted LAN, the direct equivalent is `http://<vos-host>:22710/mcp`. | `Authorization: Bearer <V-Note API token>`. |
| HTTP integration | Use the gateway app base above, or `http://<vos-host>:22710` on a trusted LAN. Append the endpoint path below. | Follow the endpoint's authentication requirements. |
| Official EdgeEver app for iOS or Android | Enter the server base, such as `https://<vos-host>:1180/app/com.ictrek.v-note`. Leave off `/api`, `/mcp` and `?local=1`. | The native client submits an EdgeEver username and password. Ordinary VOS SSO accounts cannot sign in through this screen. The separately configured local break-glass administrator is the only initial local account. |

The gateway route is registered by the VOS package. Compose already maps host TCP `22710` to container HTTP `8787` for both CPU profiles. Add no second Docker mapping. A mobile device must be able to reach the gateway or LAN address. For access away from the LAN, use a reachable HTTPS gateway or VPN. A trusted certificate is required for native HTTPS clients; a browser exception for a self-signed certificate does not transfer to the app. Use the direct HTTP port only within a trusted network. The direct port exposes HTTP APIs and MCP. The VOS browser workspace requires the VOS iframe bridge.

### Native mobile sign-in and account isolation

Open the EdgeEver app and fill in Server URL, Username and Password. This calls `POST /api/v1/auth/login`. VOS-backed users are created with a generated local password hash; the VOS password is never forwarded to V-Note. Neither the VOS access token nor a V-Note MCP token can replace the password in this form. The official iOS and Android clients do not perform the VOS iframe/OIDC flow. To use your usual VOS workspace from a phone, open VOS in a browser, sign in, then launch V-Note from the App Drawer.

If the device owner configured `VNOTE_BREAK_GLASS_PASSWORD` at installation, the local `admin` account can use password login for emergency access. It has a separate identity and workspace. If two-factor authentication is enabled for that local account, follow the native client's authenticator or recovery-code prompt. A refused connection or TLS error happens before credential verification; check address, network access and certificate trust first. For ordinary VOS accounts, use the browser flow instead of enabling the emergency account just for syncing.

The standalone VOS mobile app and the EdgeEver native app are separate clients. The V-Note package declares desktop VOS routes. It does not publish a VOS mobile WebView entry via `app-routers`.

## HTTP API

Routes below are relative to the base URL in the table. JSON routes return `application/json`. A V-Note session is an interactive user's `edgeever_session` cookie or V-Note session Bearer value. An API token is a workspace-scoped integration credential. A VOS access token is accepted by the VOS exchange route and is a different credential. Notes, notebooks and tokens are scoped to the authenticated workspace. Instance administrators manage users and storage through the application, with each user's notes remaining in that user's workspace.

### Connectivity and sign-in

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/health` | Public. No body or query. | `200`. `ok` boolean, `name` service identifier, `runtime` runtime, `authMode` authentication mode (`vos` in this package), `build` short source identifier, `migration` last applied migration identifier, `deployment` deployment descriptors, `deploymentVersionCreatedAt` version timestamp, `storage.database` and `storage.resources` driver names, and `objectStorageProvider` (`builtin`, `s3` or `unknown`). Self-hosted responses include image provenance fields when available. |
| `POST /api/v1/auth/vos` | `Authorization: Bearer <VOS app access token>`. Optional `Accept-Language` seeds the workspace language at first sign-in. Optional `x-edgeever-device-id` identifies the browser. No body. The VOS bridge obtains the access token with authorization code + PKCE (S256), client ID `com.ictrek.v-note`, scopes `openid profile email`. | `200` session summary and `Set-Cookie: edgeever_session=…` (HttpOnly, SameSite=Lax). Creates the workspace on first sign-in, updates mapped identity and creates or refreshes a V-Note session. The platform token itself is not stored. |
| `GET /api/v1/auth/session` | Optional V-Note session. No body or query. | `200` session summary. With no valid user session, `authenticated:false` and `user:null`. An API token does not establish an interactive session. |
| `POST /api/v1/auth/login` | JSON `username` (trimmed 1–80), `password` (1–512), optional `deviceId` (trimmed 16–160), optional `locale` (trimmed 1–35, first-sign-in locale). Omit optional fields when unavailable. Only local credentials are checked. | `200` session summary with `sessionToken` (the V-Note session Bearer value) and session cookie. The server creates or refreshes the device session. |
| `POST /api/v1/auth/login/mfa` | JSON `challengeToken` (trimmed 16–128), exactly one of `code` (6–12) or `recoveryCode` (10–32), optional `deviceId` and `locale` with the same limits as login. | Same session shape after successful verification. Recovery-code sign-in may return `mfaRebindRequired:true` and a restricted session that must rebind MFA. |

The session summary contains booleans `authRequired`, `authenticated`, `demoMode`, `vosMode`, and `user`, which is null or an object with string `id`, string `username`, nullable string `displayName` and role `owner` or `member`. `mfaRebindRequired` is present only when true. The VOS session lifetime is configured by `VNOTE_SESSION_TTL_DAYS` (default 7 days); opening the VOS app revalidates the VOS account.

Example reachability and signed-out session checks:

```sh
BASE='https://<vos-host>:1180/app/com.ictrek.v-note'
curl --fail-with-body "$BASE/api/health"
curl --fail-with-body "$BASE/api/v1/auth/session"
```

HTTP application errors usually use `{"error":{"code":"…","message":"…"}}`; malformed request validation can return a Zod error with field issues. A local password challenge is HTTP 401 `mfa_required` with `error.details` containing `challengeToken`, UTC `expiresAt` and `methods:["totp","recovery_code"]`. Submit the second factor before expiry; restart login if the challenge expires. Treat HTTP 429 `login_rate_limited` as a delay and honor `Retry-After` (seconds). Incorrect local credentials give 401 `unauthorized`. VOS exchange errors include 401 `unauthorized` for a missing token or `vos_auth_rejected` for a rejected token, 403 `vos_user_disabled`, 404 `not_found` outside VOS mode, 502 `vos_userinfo_invalid` for a malformed identity response, and 503 `vos_userinfo_not_configured` or `vos_userinfo_unreachable`. The VOS userinfo call has a 10-second timeout. Retry a transient 502/503 after service recovery; re-open V-Note in VOS for a rejected token. A 503 health response can also report `auth_not_configured` or `object_storage_not_ready`. `GET /api/openapi.json` is a reachability probe.

### Manage integration tokens

In V-Note, open **Profile → API / MCP**. Name the token, select **Read-only** for listing/search or **Full access** for edits, then select **Create Token → Copy MCP config**. Delete a leaked token and replace it in the client. Full access is the current UI default, so explicitly select Read-only if the client only reads.

| Method and path | Inputs and result |
| --- | --- |
| `GET /api/v1/api-tokens` | Interactive session. No inputs. `200 {apiTokens: ApiToken[], availableScopes: string[]}` with up to 200 workspace tokens. Empty list is `[]`. |
| `POST /api/v1/api-tokens` | Interactive session. JSON `name` (trimmed 1–80), `scopes` (1–32 exact strings, duplicates normalized), optional `expiresAt` (ISO-8601 UTC datetime, null or omitted for no expiration). `201 {token: string, apiToken: ApiToken}`. Creates a new token each time. |
| `DELETE /api/v1/api-tokens/{id}` | Interactive session. `id` is the opaque token ID from the list. No body. `200 {ok:true}`; repeated deletes are safe. Only a token in the caller's workspace can be deleted. |

`ApiToken` fields are `id` (opaque string), `name`, `token` (secret string, null for older records without a recoverable value), `scopes` (string array), `lastUsedAt` and `expiresAt` (UTC datetime or null), `isRevoked` (boolean), `createdAt` (UTC datetime). Protect both list and create responses as secrets. A missing session is 401, an integration token used for token management is 403, and invalid input or unknown scope is 400. An unexpected missing token row after creation can return 404. Expired, deleted and invalid tokens fail subsequent authentication.

| Scope | Purpose |
| --- | --- |
| `read:notebooks` / `write:notebooks` | Read / change notebook structure. |
| `read:memos` / `write:memos` | Read / change notes and note templates. |
| `read:resources` / `write:resources` | Read / upload and change attachments. |
| `read:tags` / `write:tags` | Read / modify tags. |
| `ai:generate` | Use supported AI operations; configure the model where required. |

Read-only selects the four `read:*` scopes. Full access selects all nine. Endpoints and tools may require more than one scope. A Bearer token is tied to its workspace and never grants another workspace's access.

## MCP protocol and first calls

Use Streamable HTTP JSON-RPC 2.0. Send one JSON object per `POST /mcp` with `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and the Bearer API token. The server replies with JSON for calls and HTTP 202 with no body for accepted notifications. There is no SSE event feed, resumable stream, MCP session ID or server-push subscription. `GET /mcp` is HTTP 405 with `Allow: POST`.

| Method | Request and response |
| --- | --- |
| `initialize` | Legacy clients send `params.protocolVersion`, `capabilities` and `clientInfo`. Returns the negotiated `protocolVersion`, `serverInfo`, `capabilities.tools.listChanged:false`, and `instructions`. Legacy protocol values are `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`. An omitted or unsupported version in the initialize body falls back to `2025-11-25`. |
| `notifications/initialized` | Legacy notification without an `id`. HTTP 202. |
| `server/discover` | Protocol `2026-07-28` discovery. Returns `supportedVersions`, tool capabilities, instructions and cache information (`ttlMs:3600000`, `cacheScope:"public"`). |
| `tools/list` | No filters or paging arguments. Returns `tools` with tool name, title, description, input/output schemas and annotations. Listed tools can still fail for insufficient token scope. |
| `tools/call` | `params.name` is a catalog tool name, `params.arguments` is an object (omit for a tool without inputs). `result.isError` reports tool-level success. `structuredContent` contains the payload or `{error:{code,message}}`. `content` includes a text representation and, for visual outputs that supply one, an image item with base64 data and MIME type. |

Every request contains `jsonrpc:"2.0"` and a method string. Calls use a string or numeric `id`; notifications omit it. Responses echo the ID and contain either `result` or `error:{code,message,data?}`. The modern protocol requires `MCP-Protocol-Version: 2026-07-28`, matching `params._meta["io.modelcontextprotocol/protocolVersion"]`, a matching `Mcp-Method` header, and `Mcp-Name` matching `params.name` for tool calls. Supply the object `params._meta["io.modelcontextprotocol/clientCapabilities"]`; optional `io.modelcontextprotocol/clientInfo` has string `name` and `version`. Modern results include `resultType:"complete"` and server info in `_meta`. Use a client supporting these mirrored headers for this protocol version.

```sh
# Set VNOTE_TOKEN to the value copied from V-Note in your local secret environment.
MCP='https://<vos-host>:1180/app/com.ictrek.v-note/mcp'
curl --fail-with-body "$MCP" \
  -H "Authorization: Bearer $VNOTE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_current_user","arguments":{}}}'
```

Check the returned account, workspace and scopes. Then call `list_notebooks` to confirm access; its payload is `{notebooks: [...]}` and can be empty. The tool requires `read:notebooks`. For example, run `search_memos` with `{"query":"kickoff"}` and `read:memos`; an empty search returns `{memos:[]}`. Use the catalog below or `tools/list` for exact arguments and constraints. Check tool results before retrying changes; a transport failure alone does not prove a write was skipped. Anonymous shares, public notebook publishing and public collection forms are disabled in VOS.

| HTTP / RPC | Meaning and action |
| --- | --- |
| 400 / `-32700` | Malformed JSON. Send valid JSON. |
| 400 / `-32600` | Invalid JSON-RPC request or a batch array. Send one object with version and method. |
| 400 / `-32602` | Missing/unknown tool name or invalid modern client metadata. Check the catalog and protocol headers. |
| 400 / `-32020`, `-32022` | Header/body mismatch or unsupported protocol version. Match headers or negotiate a supported version. |
| 401 / `-32001` | Missing, invalid, expired or revoked credential. See `WWW-Authenticate`; use a valid token from this instance. |
| 403 / `-32003` | A foreign browser Origin is denied. Use a same-origin or native MCP client. |
| 404 / `-32601` | Unknown RPC method. Check the method and negotiated protocol. |
| 405, 406, 415 | Use POST, both required Accept types, and JSON Content-Type. |
| 200 / `isError:true` | The call reached a tool. Read `structuredContent.error.code` and `message` for field, scope, missing record, conflict, or service errors. Correct the input or permissions before retrying. |
