# Subscription-independent publishing

Updated 2026-10-17. The Azure student subscription and its managed identity are no longer used by these repository workflows.

## Primary workflow

GitHub Actions `.github/workflows/package.yml` runs on main commits, `v*` tags and manual dispatch. It installs locked dependencies, runs existing checks, validates version tags, builds a VSIX and uploads it with a SHA256 sidecar as the `marketplace-vsix` artifact. Permissions are read-only for repository contents. No Marketplace credentials or Azure service connection are required.

A version tag prepares a release package; it does **not** publish to Marketplace. GitHub artifact retention is 30 days. No plugin version is bumped by this migration.

## Final upload

1. Download and extract the `marketplace-vsix` artifact from the successful GitHub run, or run `node tools/prepare-release.cjs` locally (Node.js 22 and installed dependencies required).
2. Open https://marketplace.visualstudio.com/manage/publishers/YuHaoran251 using the existing Microsoft account.
3. Select the intended extension, More Actions → Update, choose the generated VSIX, and Upload.
4. Wait until verification completes and confirm the exact version is Public. An uploaded/Verifying package is not yet a completed release.

Local PowerShell entry point: `pwsh -File tools/release.ps1`. `-DryRun` remains accepted; both modes only check and package. Old PAT, Bitwarden, automatic version bump and automatic push parameters are removed.

The legacy `azure-pipelines.yml` is manual-only and only checks/packages. Old hosted service connections, identities and membership are not deleted or modified. No subscription upgrades, new tokens, permissions or production releases are performed by this migration.

Official manual upload instructions: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension
