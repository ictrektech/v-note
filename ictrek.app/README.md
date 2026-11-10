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

For a release, commit and push the tested source first. On the matching hosts,
build the same clean commit and publish `amd_<version>` with
`--profile amd --sheet AMD_with_mxn100 --push` and `arm_<version>` with
`--profile arm --sheet ARM_without_cuda --push`. These commands also register
the tags in the VOS release spreadsheet. Verify both tags and the device upgrade
before running `ictrek.app/scripts/update_version.sh patch` from a clean tree.
The version bump must be the only change in its commit. The trigger tag starts
`vos-release.yml`, which verifies both image source labels, pins their digests,
creates the GitHub Release and publishes its package to the VOS App Store.
The workflow needs `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `APPSTORE_IP` and
`APPSTORE_TOKEN` repository secrets. Monitor the workflow and verify its release
and store readback; a pushed tag alone does not mean publication succeeded.
To retry a failed publication, dispatch the workflow at the existing trigger tag
with its version in `retry_version`; the workflow refuses a mismatched public tag
or package.
