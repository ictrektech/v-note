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

## Upstream merges and release versions / 上游合并与版本

Merge the official EdgeEver release tag with Git. Resolve conflicts while retaining the VOS integration, and inspect `.github/workflows/` before committing. Only `vos-release.yml` belongs in this fork; remove incoming upstream workflows, including new files. Validate the merge against an isolated upgrade from the installed release. The upstream Cloudflare snapshot workflow is intentionally absent from V-Note.

上游更新通过 Git 合并 EdgeEver 正式标签，解决冲突时保留 VOS 适配。提交前检查 `.github/workflows/`，仅保留自己的 `vos-release.yml`，包括上游新加入的工作流也要移除。用隔离实例验证已发布版本升级。V-Note 已移除上游 Cloudflare 快照同步任务。

GitHub uses `vX.Y.Z.vos.01`, `vX.Y.Z.vos.02`, and so on. Each new upstream `X.Y.Z` starts at `.vos.01`. The same releases use VOS SemVer package versions `X.Y.Z-vos.1`, `X.Y.Z-vos.2`, etc., so VOS can order upgrades numerically. `update_version.sh --print` shows the next GitHub label; `--print-package` shows its VOS package version. Failed publications reuse the existing trigger via retry instead of reserving a new number.

GitHub 发布标签按上游版本使用 `vX.Y.Z.vos.01`、`vX.Y.Z.vos.02` 递增，新上游版本从 `.vos.01` 重新开始。VOS 包版本对应 `X.Y.Z-vos.1`、`X.Y.Z-vos.2`，以便按 SemVer 数值排序。`update_version.sh --print` 查看下一个发布编号，`--print-package` 查看包版本。发布失败时重试已有触发标签。

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
