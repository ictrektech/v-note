## 连接方式

| 客户端 | 地址 | 认证 |
| --- | --- | --- |
| VOS 浏览器 | 从应用抽屉打开 V-Note。网关挂载地址为 `https://<VOS 主机>:1180/app/com.ictrek.v-note`，协议和端口以设备实际配置为准。 | VOS 内嵌桥接通过 OIDC 为当前账号自动登录。 |
| 外部 MCP 客户端 | 优先用 `https://<VOS 主机>:1180/app/com.ictrek.v-note/mcp`；可信局域网可用 `http://<VOS 主机>:22710/mcp`。 | `Authorization: Bearer <V-Note API Token>`。 |
| HTTP API 集成 | 在上面的网关应用基址，或可信局域网的 `http://<VOS 主机>:22710` 后拼接接口路径。 | 按各接口的认证要求调用。 |
| EdgeEver 官方 iOS / Android 客户端 | 服务器地址填 `https://<VOS 主机>:1180/app/com.ictrek.v-note` 这样的基址，末尾不用填 `/api`、`/mcp` 或 `?local=1`。 | 在 EdgeEver 登录页填写自己的 VOS 用户名和密码。普通用户和管理员均进入自己原有的 VOS 工作区。仅支持受信任的 HTTPS VOS 网关。 |

VOS 安装包已注册网关路由，同时把宿主机 TCP `22710` 映射到容器 HTTP `8787`，AMD64 与 ARM64 均如此。设备无需另配 Docker 端口映射。手机须能访问 VOS 网关或局域网地址；外网访问用可达的 HTTPS 网关或 VPN。原生客户端要求 HTTPS 证书受手机信任，浏览器手工放行证书不会改变客户端的信任状态。直连 HTTP 端口可用于可信网络内的 API 和 MCP，不能使用 VOS 密码登录；网页工作区需要 VOS iframe 桥接。

### 手机原生应用登录

1. 安装 **EdgeEver**：[iPhone App Store](https://apps.apple.com/us/app/edgeever/id6792625631) · [Android Google Play](https://play.google.com/store/apps/details?id=org.edgeever.mobile)。
2. 在 EdgeEver 的「实例地址」填 `https://<VOS 网关>:1180/app/com.ictrek.v-note`，协议、主机和端口以实际网关为准。地址末尾不加 `/api`、`/mcp` 或 `?local=1`。手机须能访问网关，并信任它的 HTTPS 证书。无需新增端口映射。
3. 在同一页填写自己的 **VOS 用户名和密码**，点「登录」。无需先打开网页、生成配对码或创建其他账号。不要填 Token。若 V-Note 账号已启用两步验证，按 App 提示验证。
4. 打开「全部笔记」，等待首次同步，即可查看和编辑这个 VOS 账号原有的笔记。关闭后再打开 App 不必重登。主动退出、会话过期（默认 7 天）或换设备时，再用同一 VOS 账号登录。

如果证书不受手机信任，请联系管理员为 VOS 网关配置受信任的证书并使用匹配的域名；不要改用 `http://<VOS 主机>:22710` 提交 VOS 密码。登录失败时可先确认同一账号能在 VOS 网页登录。安装时若配置了本地应急 `admin`，原有本地访问仍可使用，其工作区独立于 VOS 用户。

VOS 手机 App 和 EdgeEver 原生客户端是两个不同的客户端。V-Note 安装包声明了桌面 VOS 路由，未通过 `app-routers` 声明 VOS 手机 App 的 WebView 入口。

## HTTP API

下表路径相对于上文的应用基址。JSON 接口返回 `application/json`。V-Note 交互会话可用 `edgeever_session` Cookie 或 V-Note 会话 Bearer 值。API Token 属于指定工作区，用于集成。VOS access token 用于网页端交换 V-Note 会话。笔记、笔记本和 Token 按已认证工作区隔离。实例管理员可管理用户和存储，笔记由各自工作区的身份访问。

### 连通性和登录

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /api/health` | 公开接口。无请求体或查询参数。 | `200`。返回 `ok` 布尔值、服务标识 `name`、运行时 `runtime`、认证模式 `authMode`（此包为 `vos`）、源代码标识 `build`、最新迁移标识 `migration`、部署描述 `deployment`、版本时间 `deploymentVersionCreatedAt`、存储驱动 `storage.database` 和 `storage.resources`、对象存储 `objectStorageProvider`（`builtin`、`s3` 或 `unknown`）。自托管响应还会包含可用的镜像来源字段。 |
| `POST /api/v1/auth/vos` | `Authorization: Bearer <VOS 应用 access token>`。可选 `Accept-Language` 初始化工作区语言；可选 `x-edgeever-device-id` 标识浏览器。无请求体。平台桥接使用授权码 + PKCE（S256），客户端 ID `com.ictrek.v-note`，scope 为 `openid profile email`。 | `200` 会话摘要及 `Set-Cookie: edgeever_session=…`（HttpOnly、SameSite=Lax）。首次创建工作区，登录时更新映射身份并创建或刷新 V-Note 会话。平台 Token 不落库。 |
| `GET /api/v1/auth/session` | 可选 V-Note 会话。无请求体或查询参数。 | `200` 会话摘要。无有效用户会话时 `authenticated:false`，`user:null`。API Token 不建立交互会话。 |
| `POST /api/v1/auth/login` | JSON `username`（去空白后 1–80 字符）、`password`（1–512）、可选 `deviceId`（去空白后 16–160）、可选 `locale`（去空白后 1–35，首次登录语言）。可选字段没有值时省略。VOS 的 HTTPS 网关可接收 VOS 用户名和密码，由平台校验；现有本地账号也可用原密码。无需管理员角色。直连 HTTP 不验证 VOS 密码。 | `200` 会话摘要、`sessionToken`（V-Note 会话 Bearer 值）及会话 Cookie。创建或更新设备会话。 |
| `POST /api/v1/auth/login/mfa` | JSON `challengeToken`（去空白后 16–128）、`code`（6–12）和 `recoveryCode`（10–32）二选一、可选 `deviceId` 和 `locale`（同登录接口）。 | 成功返回同样的会话结构。恢复码登录可能返回 `mfaRebindRequired:true` 和受限会话，此时须重新绑定 MFA。 |

会话摘要包含布尔值 `authRequired`、`authenticated`、`demoMode`、`vosMode`。字段 `user` 为 null，或包含字符串 `id`、`username`、可空字符串 `displayName` 和 `role`（`owner` 或 `member`）的对象。`mfaRebindRequired` 仅在为 true 时出现。会话有效期由 `VNOTE_SESSION_TTL_DAYS` 配置，默认 7 天。每次从 VOS 打开应用都会重新校验 VOS 用户。

```sh
BASE='https://<VOS 主机>:1180/app/com.ictrek.v-note'
curl --fail-with-body "$BASE/api/health"
curl --fail-with-body "$BASE/api/v1/auth/session"
```

HTTP 业务错误通常为 `{"error":{"code":"…","message":"…"}}`。输入校验错误可能返回带字段问题的 Zod 响应。本地账号需要两步验证时返回 HTTP 401 `mfa_required`，`error.details` 含 `challengeToken`、UTC `expiresAt`、`methods:["totp","recovery_code"]`，超时需重新登录。HTTP 429 `login_rate_limited` 请按 `Retry-After`（秒）等待。密码错误为 401 `unauthorized`。VOS 交换接口可能返回 401 `unauthorized`（缺 Token）、401 `vos_auth_rejected`（Token 被拒）、403 `vos_user_disabled`、404 `not_found`（非 VOS 模式）、502 `vos_userinfo_invalid`、503 `vos_userinfo_not_configured` 或 `vos_userinfo_unreachable`。调用 VOS userinfo 的超时为 10 秒。502/503 在服务恢复后重试；Token 被拒时从 VOS 重新打开应用。健康检查的 503 还可能是 `auth_not_configured` 或 `object_storage_not_ready`。`GET /api/openapi.json` 用于连通性探测。

VOS 密码登录由平台 `POST /v1000/user/login` 验证，并通过 `GET /v1000/oauth2/userinfo` 获取启用状态和用户标识。V-Note 不保存 VOS 密码或 VOS Token。首次登录可创建工作区；已有用户进入同一工作区。直连 HTTP 使用非本地凭据返回 `403 vos_https_required`；账号密码错误返回 `401 unauthorized`；平台拒绝账号状态返回 `403 vos_login_rejected` 或 `vos_user_disabled`。平台登录超时、异常响应或服务不可用返回 `503 vos_login_unavailable`；userinfo 错误同上。两次平台请求各最多等待 10 秒。旧的配对接口已移除，已有会话仍可用。

```sh
curl --fail-with-body -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"<VOS 用户名>","password":"<VOS 密码>"}'
```

### 管理 API Token

进入 **个人中心 → API / MCP**。命名 Token，搜索和读取选 **只读访问**，编辑选 **完全访问**。界面默认为完全访问，只读客户端需手动切换。点击 **创建 Token**，从新条目复制 MCP 配置。Token 泄露时删除该条目，创建新 Token 并更新客户端。

| 方法与路径 | 输入和响应 |
| --- | --- |
| `GET /api/v1/api-tokens` | 交互会话，无输入。返回 `200 {apiTokens: ApiToken[], availableScopes: string[]}`，最多 200 条当前工作区记录，无记录时为 `[]`。 |
| `POST /api/v1/api-tokens` | 交互会话。JSON `name`（去空白后 1–80 字符）、`scopes`（1–32 个精确值，自动去重）、可选 `expiresAt`（ISO-8601 UTC 时间，null 或省略表示不过期）。返回 `201 {token: string, apiToken: ApiToken}`，每次成功调用都会创建新的 Token。 |
| `DELETE /api/v1/api-tokens/{id}` | 交互会话。路径 `id` 为列表返回的 Token 标识，无请求体。返回 `200 {ok:true}`，可重复调用，操作仅限调用者的工作区。 |

`ApiToken` 包含 `id`（不透明字符串）、`name`、`token`（密钥字符串；无法取回明文的旧记录为 null）、`scopes`（字符串数组）、`lastUsedAt` 和 `expiresAt`（UTC 时间或 null）、`isRevoked`（布尔值）、`createdAt`（UTC 时间）。列表与创建结果均需按密钥保护。缺少会话为 401；用 API Token 管理 Token 为 403；输入或 scope 无效为 400；创建后意外读不到记录可返回 404。过期、已删除或无效的 Token 无法认证。

| Scope | 用途 |
| --- | --- |
| `read:notebooks` / `write:notebooks` | 读取 / 修改笔记本结构。 |
| `read:memos` / `write:memos` | 读取 / 修改笔记和笔记模板。 |
| `read:resources` / `write:resources` | 读取 / 上传和修改附件。 |
| `read:tags` / `write:tags` | 读取 / 修改标签。 |
| `ai:generate` | 调用支持的 AI 操作，按需先配置模型。 |

只读访问包含四个 `read:*` 权限，完全访问包含全部九个权限。一项操作可能同时需要多个权限。Bearer Token 绑定到创建时的工作区。

## MCP 协议和首次调用

使用 Streamable HTTP JSON-RPC 2.0。每个 `POST /mcp` 发送一个 JSON 对象，请求头为 `Content-Type: application/json`、`Accept: application/json, text/event-stream` 和 Bearer API Token。调用返回 JSON，已接受的通知返回 HTTP 202 空响应。服务不提供 SSE 事件流、流式续传、MCP session ID 或服务器推送订阅。`GET /mcp` 返回 HTTP 405 和 `Allow: POST`。

| 方法 | 请求与响应 |
| --- | --- |
| `initialize` | 旧协议客户端提交 `params.protocolVersion`、`capabilities`、`clientInfo`。响应有协商后的 `protocolVersion`、`serverInfo`、`capabilities.tools.listChanged:false` 和 `instructions`。支持 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`。请求体省略或版本不支持时回退到 `2025-11-25`。 |
| `notifications/initialized` | 旧协议通知，不带 `id`，返回 HTTP 202。 |
| `server/discover` | `2026-07-28` 协议发现方法。返回 `supportedVersions`、工具能力、说明和缓存信息（`ttlMs:3600000`、`cacheScope:"public"`）。 |
| `tools/list` | 无筛选或分页参数。返回 `tools`，含名称、标题、说明、输入/输出 schema 和注解。列出的工具仍需满足调用权限。 |
| `tools/call` | `params.name` 为工具名称，`params.arguments` 为参数对象（无参数可省略）。`result.isError` 表示工具执行是否失败。`structuredContent` 返回数据或 `{error:{code,message}}`。`content` 包含文本；返回图像的工具另附含 base64 和 MIME 类型的图片项。 |

请求均包含 `jsonrpc:"2.0"` 与方法名。调用的 `id` 为字符串或数字，通知省略。响应带同一个 ID 和 `result` 或 `error:{code,message,data?}`。`2026-07-28` 要求 `MCP-Protocol-Version` 与 `params._meta["io.modelcontextprotocol/protocolVersion"]` 一致、`Mcp-Method` 与方法名一致；调用工具时 `Mcp-Name` 与 `params.name` 一致。`params._meta["io.modelcontextprotocol/clientCapabilities"]` 为必填对象，可选 `io.modelcontextprotocol/clientInfo` 包含字符串 `name` 和 `version`。新版结果附 `resultType:"complete"` 和 `_meta` 中的服务器信息。使用支持这些镜像请求头的客户端。

```sh
# 在本地密钥环境中设置 VNOTE_TOKEN 为从 V-Note 复制的值。
MCP='https://<VOS 主机>:1180/app/com.ictrek.v-note/mcp'
curl --fail-with-body "$MCP" \
  -H "Authorization: Bearer $VNOTE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_current_user","arguments":{}}}'
```

核对返回的账号、工作区与权限。再调用 `list_notebooks`（需 `read:notebooks`），结果为 `{notebooks: [...]}`，可以为空。例如传 `{"query":"启动"}` 调用 `search_memos`，需 `read:memos`，无匹配时返回 `{memos:[]}`。精确入参及约束见下方工具目录或 `tools/list`。重试写入前核对结果，传输中断不能说明写入是否完成。VOS 版关闭匿名分享、公开发布笔记本和公开收集表单。

| HTTP / RPC | 含义和操作 |
| --- | --- |
| 400 / `-32700` | JSON 解析失败，修正请求体。 |
| 400 / `-32600` | 无效 JSON-RPC 请求或发送了批量数组。每次发送一个包含版本和方法的对象。 |
| 400 / `-32602` | 缺工具名、工具名未知或新版客户端元数据无效。核对目录与协议请求头。 |
| 400 / `-32020`、`-32022` | 请求头与正文不一致，或版本不支持。匹配请求头或协商支持的版本。 |
| 401 / `-32001` | 缺凭据、凭据无效、过期或被撤销。查看 `WWW-Authenticate`，使用当前实例的有效 Token。 |
| 403 / `-32003` | 浏览器 Origin 与服务不一致。改用同源或原生 MCP 客户端。 |
| 404 / `-32601` | 方法不存在。检查方法名与协商版本。 |
| 405、406、415 | 检查 POST 方法、Accept 的两个类型和 JSON Content-Type。 |
| 200 / `isError:true` | 已进入工具处理。查看 `structuredContent.error.code` 和 `message` 定位字段、权限、记录缺失、冲突或服务错误，修正后再重试。 |
