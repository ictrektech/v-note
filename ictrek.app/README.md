# V-Note VOS package

This directory builds the VOS application package for V-Note. It wraps the
upstream EdgeEver Docker image with VOS single sign-on, per-user workspaces,
and the VOS feature boundary.

The package uses a pull package: the outer tarball contains exactly
`app.tar.gz`, and the inner archive contains the manifest, Compose file,
configs, routers, icon, and localized README files.

Build and package:

```sh
VNOTE_BUILD_COMMIT=<local-commit> VNOTE_SOURCE_STATE=dirty \
  bash ictrek.app/scripts/build_image.sh --profile amd --tag <registry/image:tag>

VNOTE_AMD_IMAGE=swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-note:amd_0.0.1 \
VNOTE_ARM_IMAGE=swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-note:arm_0.0.1 \
bash ictrek.app/scripts/package.sh
```

Open **API Guide** from the V-Note group in VOS, or use **Profile → API / MCP → API Guide**. See the [English guide](../docs/vos-api-guide.md) and [中文指南](../docs/vos-api-guide.zh-CN.md) for gateway and direct addresses, authentication, mobile support and request examples.

The package is written to `ictrek.app/dist/v_note_<version>_pull.tar`.

## HybRAG integration

In VOS, open **Profile → Integrations → HybRAG**. Select one or more non-overlapping notebook roots, choose a manual, interval, or night schedule, then save. **Sync now** keeps the page open while indexing one note at a time. Interval and night schedules continue in the background after the page closes when the installed HybRAG supports VOS background authorization.

The same VOS user must first be associated in HybRAG under **Settings → User Profile → Associate VOS account**. HybRAG must also have a working default embedding model. The integration reads only the selected notebook trees. Pausing or stopping synchronization retains existing searchable copies; background reconciliation later removes copies for deleted or moved-out notes. Special formats, embedded resources, empty notes, oversized notes, unknown model outcomes, and managed knowledge-base deletion have the limitations shown in the page.

These browser and HybRAG app-to-app routes are private integration contracts, not V-Note API-token or MCP capabilities. The browser routes require a current VOS user proof from the VOS bridge. HybRAG receives only a restricted integration credential issued through the VOS grant protocol.

在 VOS 中打开 **个人中心 → 集成 → HybRAG**，选择一个或多个互不重叠的笔记本根，设置手动、间隔或夜间计划后保存。“立即同步”需要保持页面打开并逐篇索引；已安装的 HybRAG 支持 VOS 后台授权时，间隔和夜间计划会在关闭页面后继续运行。

首次使用前，须在 HybRAG 的 **设置 → 用户信息 → 关联 VOS 账号** 确认同一 VOS 用户，并在 HybRAG 配置可用的默认 Embedding 模型。同步只读取所选笔记本子树；暂停或停止会保留已有可搜索副本，后台对账随后清理已删除或移出范围的副本。特殊格式、内嵌资源、空白或过长笔记、未知模型结果和托管知识库删除仍受页面提示的限制。

这些浏览器与 HybRAG 的应用间接口属于私有集成契约，不通过 V-Note API Token 或 MCP 提供。浏览器接口要求 VOS 桥接签发的当前用户证明；HybRAG 只获得通过 VOS 授权协议签发的受限集成凭据。

Build each profile on its matching architecture from the same source snapshot.
Pass the local checkout's commit as `VNOTE_BUILD_COMMIT` and its actual state as
`VNOTE_SOURCE_STATE` (`clean` or `dirty`); both are recorded as image labels.
Use a unique tag for each candidate and verify the image references before
packaging. The current VOS installation stores its database and attachments in
the `data/data` path beneath the application storage root; preserve that mapping
and existing storage during upgrades. Verify sign-in, existing notes, attachments,
MCP, and user isolation on both profiles after upgrading.

The VOS package icon is `src/icon.png`; matching browser icons are in
`apps/web/public/v-note-*.png`. The candidate package command does not publish.

干净镜像构建会先生成 `@edgeever/plugin-api` 工作区产物，再构建 Web 和自托管服务；
不依赖维护者本机残留的 `packages/plugin-api/dist`。
Clean image builds generate the `@edgeever/plugin-api` workspace before building
the Web bundle and self-hosted server, without relying on a local generated
`packages/plugin-api/dist` directory.

本机候选预检使用构建脚本默认的不推送模式；打包不写飞书。原生 ARM64 构建仍可能下载
基础镜像和 Bun/npm/系统依赖，需设备能访问对应仓库；不是笔记解析，不调用模型。
尚未推送的候选镜像配合 `pull_policy: always` 只能做包结构预检，不能当作可分发升级包。

Local candidate checks use the build script's default mode without pushing;
packaging does not write Feishu. Native ARM64 builds may still download base
images and Bun/npm/system dependencies. This does not parse notes or call models.
With `pull_policy: always`, unpublished candidate images support package checks,
but do not make a distributable upgrade package.

## HybRAG integration development

明确的索引前模型拒绝会保留进度，修复 HybRAG 默认模型后可再次“立即同步”。旧版本
遗留的 `hybrag_delivery_uncertain` 不能直接清除：先保存原同步设置产生新版本，待控制
变更送达后再立即同步。旧请求会被版本围栏阻止；真正仍在处理的模型任务继续占用槽位，
不会被强制释放。该恢复过程不删除笔记或已有知识库副本。

A definite pre-admission embedding refusal preserves progress and permits Sync
now after fixing the HybRAG model default. For a legacy
`hybrag_delivery_uncertain` run, save the same synchronization settings first,
wait for control delivery, then Sync now. The new configuration version fences
old requests; an actually running model task retains its processing slot. This
does not delete source notes or existing knowledge-base copies.

旧 HybRAG 账号首次联动前，需要在 HybRAG「设置 → 用户信息 → 关联 VOS 账号」确认
关联，再回到本页重试。此时仅确认两端账号归属，不读取笔记正文或启动索引；已有
冲突关联由管理员核查，不按同名自动覆盖。新建且通过严格 VOS 用户校验的账号自动关联。

For a legacy HybRAG account, first confirm association in HybRAG Settings → User
Profile → Associate VOS account, then retry this integration page. This only
confirms account ownership; it does not read note bodies or start indexing.
Existing conflicting associations require administrator review. Newly created
accounts with a strictly verified VOS user are associated automatically.

This release includes
`POST /api/v1/integrations/hybrag/identity`, requiring an authenticated V-Note
user session and JSON `{ "accessToken": "<fresh VOS user token>" }`. The proof
must match the session's persisted VOS subject and personal workspace. API
agents, disabled local users, application service credentials, and proofs for
another user are rejected. This check does not create a HybRAG connection,
read note bodies, or start indexing. Existing VOS sign-in keeps its current
behavior; the stricter human-only check applies to the new integration proof.

The next backend stage adds `POST /api/v1/integrations/hybrag/sync-note` with
JSON `{ "accessToken": "<fresh VOS user token>", "rootId": "<notebook id>",
"memoId": "<note id>" }` in the current user's authenticated session. A note
must belong to the selected notebook or an active descendant in that user's
personal workspace. Only prose Markdown title/body is supported; embedded
resources and specialized documents are rejected. The server sends a five-minute
single-use ticket to HybRAG, which redeems it at
`POST /api/integrations/hybrag/redeem` with the same fresh VOS proof. Expired,
consumed, changed, moved, deleted or no-longer-authorized notes cannot be exported.
Only ticket hashes are stored; tickets are removed after the import request.
Migration `0096_hybrag_note_tickets.sql` adds this transient state and leaves
existing notes intact. Both fresh and pre-0096 schema upgrades are covered by
automated tests; an actual VOS old-to-new upgrade remains unverified.

Migration `0097_hybrag_settings.sql` adds per-user personal-space settings,
initially disabled. `GET /api/v1/integrations/hybrag/settings` returns notebook
names and hierarchy without bodies; `PUT` uses a version to reject stale edits and
rejects overlapping roots. Scope and version are checked when issuing and redeeming
each note ticket; moving selected roots into overlap blocks further exports.
`0098_hybrag_manual_runs.sql` persists manual run progress. The VOS settings page
reuses the current user's in-memory VOS proof, discovers HybRAG and shows binding
errors; it does not bind old accounts based on names. It advances one note at a
time while the page is open, and can resume its persisted run. It reports an
index as complete only when HybRAG reports completion. Automatic note schedules
are not implemented; background authorization and control delivery are described below. Stopping or changing scope blocks new
source reads and invalidates outstanding tickets, but cannot cancel a task already
admitted by HybRAG. Existing copies are retained and source deletions or moves are
not yet reconciled; the UI warns about these limitations. A manual run is therefore
not a complete mirror or deletion reconciliation.

迁移 `0097_hybrag_settings.sql` 新增默认关闭的个人配置及目录选择，保存时校验版本和
重叠范围；签发和兑换正文票据时再次检查范围。根目录移动产生重叠时阻止后续导出。
迁移 `0098_hybrag_manual_runs.sql` 保存手动运行进度。VOS 个人中心的集成页面使用当前
用户的内存中 VOS 凭证发现 HybRAG，不按用户名自动关联旧账号。页面打开时逐篇推进，
关闭后停止领取新笔记，可恢复进度；只有目标端报告索引完成才计入已索引。自动笔记计划
尚未实现；后台授权及控制送达见下文。关闭或调整范围会阻止新的读取并使未兑换票据失效，但不能取消目标端
已经接收的任务；已有副本保留，源笔记删除或移动尚不会自动清理，界面明确提示。手动
运行因此不是完整镜像或删除对账。

开发中：迁移 0099–0100 保存控制快照和送达进度；设置页使用当前用户证明投递，失败时
显示待重试。控制版本送达后，目标端按该版本约束发布，在途内容使用独立暂存版本。
迁移 0102–0103 保存加密后台凭据、签发预留和撤销待办。保存“启用同步”时自动使用当前
VOS 桥接取得的新用户证明完成授权，不复制 Token，也不需要额外连接按钮。源端每 30 秒
有界处理控制与撤销待办，失败退避；关闭页面或服务重启后继续重试，不扫描笔记正文、不调用模型。
后台授权任务在入队、每批索引前后和发布前核对当前平台状态、源范围、配置版本及内容版本；
不可核验时保留旧的已发布副本并停止推进。已知没有外部调用在途时才释放槽位，模型超时结果未知时仍保留。
这不是跨服务瞬时撤权保证。未取得后台能力时仍可使用原手动流程；已撤销的委托不能退回宽权限令牌。
手动任务在发送前持久记录待处理项；发送结果不明时停止并提示需要恢复，避免把旧版本
的完成状态误认为本次成功。当前尚无自动消除这种不确定状态的机制。
迁移 0101 保存索引尝试标识；目标状态必须与本次尝试一致才计入完成，旧目标未返回标识时
停止并提示需要恢复。此前已在运行的旧任务没有标识，也会保守停止。

In development: migrations 0099–0100 persist control snapshots and delivery
progress. The settings page delivers them with the current user proof and shows
pending delivery. Once a control version reaches HybRAG, publication is ordered
against it and unfinished content stays in a separate staging generation.
Migrations 0102–0103 persist encrypted grants, issuance reservations and revocation
outboxes. Saving enabled sync obtains a fresh proof through the current VOS bridge;
there is no token-copy or extra Connect step. Every 30 seconds, bounded server
maintenance retries controls and revocations with backoff, including after page
closure or restart. It neither scans note bodies nor invokes models.
Delegated tasks check platform status, source scope, configuration and content
version at admission, around every index batch and before publication. Failures
stop advancement and preserve the published copy. Only a boundary with no pending
external call can release its slot; an unknown model timeout cannot. This is not
instantaneous distributed revocation. Original manual operation remains available
where background capability is absent, but revoked grants cannot fall back to
broader human credentials.
Manual runs persist the pending item before sending. An ambiguous delivery stops
with recovery required rather than treating an older completed copy as success;
automatic resolution of that ambiguity is not yet implemented.
Migration 0101 persists the indexing attempt. A target status must match that
attempt before it can be counted; old targets without the identifier and older
in-flight runs without a stored identifier stop with recovery required.

开发中的增量同步使用迁移 0104–0106：仅遍历所选范围的元数据，正文未改动不调用模型。
HybRAG 持久保存游标和每篇最新待办，完整遍历成功后才对账删除或移出范围的副本；
断网保留旧副本。个人中心可选默认 15 分钟间隔、夜间窗口或仅手动模式；后台计划不依赖
页面保持打开。原“立即同步”单次运行仍需保持页面打开。账号/身份/个人空间权限曾被撤销后，
恢复权限不会复活旧授权。子树暂停和删除托管知识库仍待完成；每次 VOS 发布仍需完成旧版到新版的安装升级验收。

In development, migrations 0104–0106 add scoped metadata cursors, permanent local
authorization retirement and interval/night/manual settings. Unchanged notes do
not invoke models. HybRAG persists bookmarks and each note's latest desired state;
only successful full scans reconcile absent copies. Outages retain old copies.
Background schedules continue after closing the page; the existing Sync now run
still needs its page open. Restoring revoked user/identity/personal ownership
does not reactivate old grants. Subtree pause and managed-KB deletion remain
pending. Each VOS release still needs its installed old-to-new upgrade check.

HybRAG 的私有副本读取逐请求核验当前 VOS 用户，证明由现有桥接自动取得；停止同步后，
正常账号仍可读取保留副本。真实账号停用和升级交互尚待设备验收。
HybRAG rechecks the current VOS user for private-copy Web reads using proof from
the existing bridge. An active owner may still read retained copies after stopping
sync. Real account-disable and upgrade interactions still need device acceptance.

后台委托的安全前置条件和恢复设计见 [hybrag-background-design.md](hybrag-background-design.md)；
当前 VOS 普通刷新令牌不能作为最小权限凭据。
See [hybrag-background-design.md](hybrag-background-design.md) for the security
prerequisites and recovery design. Ordinary VOS refresh tokens are not restricted
credentials for this purpose.

Set `EDGE_EVER_HYBRAG_URL` in the server environment to override the default
`http://hybrag-app:8080`. HybRAG uses `HYBRAG_VNOTE_URL` (default
`http://v-note-backend:8787`) for redemption and must have the user's stable
account binding and an active default embedding model. Redirects are rejected.
HybRAG stores owner-private Markdown documents inline, skips unchanged content,
and rebuilds a changed note as a whole. Extra generation is off and V-Note
indexing admits one document at a time. A rejected/busy import returns a
sanitized error. Automatic scheduling and move/deletion reconciliation use the
durable flow described above; uncertain model-outcome recovery is still pending.

0107 增加整根暂停：在根卡片暂停/恢复并保存，保留可检索副本，暂停期间不读取新正文。
自动同步对近期编辑等待约一分钟稳定期，“立即同步”不等待；实际任务开始前再次检查夜间
窗口，已开始的单篇可完成。空根和仅手动后台连接也创建对应私有知识库，目录改名不调用
模型；仍需配置默认 embedding 模型。未知模型结果保持槽位并显示恢复提示。单篇/子树暂停、
知识库删除生命周期、物理清理和真实升级验收尚未完成。

Migration 0107 adds whole-root pause/resume on Save, retaining searchable copies
and blocking new body reads. Automatic sync settles recent edits for about one
minute; Sync now does not wait. Workers recheck the night window before starting,
while a started document may finish later. Empty roots and manual-only background
connections provision their private KB; directory renames invoke no models. A
default embedding configuration is still required. Unknown model outcomes retain
the slot and show a recovery warning. Per-note/subtree pause, managed-KB deletion,
physical cleanup and real upgrade acceptance remain unfinished.

仅手动及夜间窗口外仍按间隔对账笔记删除和移出范围的副本，不调用模型；整根暂停或停止
会保留副本。目标可补投确认丢失且尚未开始的后台任务，复用同一处理标识和正文；已开始、
模型结果未知及旧手动运行的完整恢复仍未完成。

Manual-only and closed night windows still reconcile deleted/moved-out note
copies at intervals without model calls. Root pause/stop retains copies. The
target can repair confirmed missing, unstarted automatic delivery using the same
attempt and stored body. Recovery of started/unknown outcomes and older manual
runs remains unfinished.

仍选中且未暂停的源根被删除或移到其他空间时，会以空范围重新对账，清理副本并保留空知识库
及原名称；恢复同一根后按当前计划重新校验并补齐。暂停或停止仍保留副本；未知在途模型可能
延后清理。已删除根不能点“立即同步”。本轮没有新增迁移；每次 VOS 发布仍需完成安装升级验收。

A deleted or moved-away, still-selected unpaused source root reconciles as an
empty scope, hiding copies while retaining the empty KB and original name.
Restoring the same root revalidates scope and catches up under the current plan.
Pause/stop retains copies; an unknown in-flight model outcome can defer removal.
Sync now is disabled for missing roots. No new migration is included in this change.
The release still needs its installed old-to-new VOS upgrade check.

## Upstream merges and release versions / 上游合并与版本

Merge the official EdgeEver release tag with Git. Resolve conflicts while retaining the VOS integration, and inspect `.github/workflows/` before committing. Only `vos-release.yml` belongs in this fork; remove incoming upstream workflows, including new files. Validate the merge against an isolated upgrade from the installed release. The upstream Cloudflare snapshot workflow is intentionally absent from V-Note.

上游更新通过 Git 合并 EdgeEver 正式标签，解决冲突时保留 VOS 适配。提交前检查 `.github/workflows/`，仅保留自己的 `vos-release.yml`，包括上游新加入的工作流也要移除。用隔离实例验证已发布版本升级。V-Note 已移除上游 Cloudflare 快照同步任务。

GitHub uses `vX.Y.Z.vos.01`, `vX.Y.Z.vos.02`, and so on. Each new upstream `X.Y.Z` starts at `.vos.01`. The same releases use VOS SemVer package versions `X.Y.Z-vos.1`, `X.Y.Z-vos.2`, etc., so VOS can order upgrades numerically. `update_version.sh --print` shows the next GitHub label; `--print-package` shows its VOS package version. Failed publications reuse the existing trigger via retry instead of reserving a new number.

GitHub 发布标签按上游版本使用 `vX.Y.Z.vos.01`、`vX.Y.Z.vos.02` 递增，新上游版本从 `.vos.01` 重新开始。VOS 包版本对应 `X.Y.Z-vos.1`、`X.Y.Z-vos.2`，以便按 SemVer 数值排序。`update_version.sh --print` 查看下一个发布编号，`--print-package` 查看包版本。发布失败时重试已有触发标签。

## Release

For a release, commit and push the tested source first. On the matching hosts,
build the same clean commit and publish `amd_<version>` with
`--profile amd --sheet AMD_with_mxn100 --push` and `arm_<version>` with
`--profile arm --sheet ARM_without_cuda --push`. These commands also register
the tags in the VOS release spreadsheet. Verify each pushed image's architecture,
full source revision, clean label and registry digest on its build host. Record
the exact version, source revision and tag@digest references in
`ictrek.app/release-images.json` and commit that record. Verify both tags and the
device upgrade before running `ictrek.app/scripts/update_version.sh` from a clean tree.
The version bump must be the only change in its commit. The trigger tag starts
`vos-release.yml`, which checks the recorded source revision and digests against
the release spreadsheet,
creates the GitHub Release and publishes its package to the VOS App Store.
The workflow needs `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `APPSTORE_IP` and
`APPSTORE_TOKEN` repository secrets. Monitor the workflow and verify its release
and store readback; a pushed tag alone does not mean publication succeeded.
To retry a failed publication before a public tag exists, dispatch the workflow
from the updated branch with its GitHub release label without the leading `v` in `retry_version`; it only accepts
release-process changes since the image source. After GitHub publication, rerun
the original workflow; it refuses a mismatched public tag or package.
