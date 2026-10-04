---
name: release
description: Prepare, publish, verify, and recover pi releases. Use for release preparation, local release smoke tests, publishing, and failed release CI or announcements.
---

# Releasing pi

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

## Fork deviations (Persisto Mate — these override the upstream flow below)

- **No CI publish**: this fork has no `.github/workflows/build-binaries.yml`. The upstream steps 4–5 (npm trusted publishing, R2 announcement) do not apply, and the upstream `npm run release:patch/minor` script is NOT used — it tags without the `-mate` suffix. The fork's convention: land the feature commit(s), then a `chore: bump packages to X.Y.Z for the vX.Y.Z-mate release` commit (lockstep `npm run version:minor|patch`, regen `npm-shrinkwrap.json` + `install-lock`, `PI_ALLOW_LOCKFILE_CHANGE=1 npm run check`), then tag `vX.Y.Z-mate` on that commit and push `main` + the tag.
- **Binaries are built locally**: `./scripts/build-binaries.sh --offline-model-data` (needs bun). Smoke test by extracting the WHOLE archive and running `--version` (must print the release version) plus one real prompt from outside the repo.
- **Release is published with `gh`**: `gh release create vX.Y.Z-mate --title "Persisto Mate vX.Y.Z" --notes-file <file> <archives>` (gh is at `C:\Program Files\GitHub CLI\gh.exe`).
- **Keep only one old release**: after publishing, delete all releases except the new one and the single most recent old one (assets go with the release; git tags stay). Current policy set 2026-10-04.
- **Version sections in CHANGELOGs**: cut a dated `## [X.Y.Z]` section for each release and leave a fresh `## [Unreleased]`. (1.0.4/1.0.5 never cut sections; the 1.1.0 section is the combined diff from 1.0.3.)

---

**Lockstep versioning** (applies to both flows): all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start each release binary from `/tmp`, not the repo root.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI verifies and announces the npm release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required. After publishing, `announce-pi-dev-release` verifies every public workspace package resolves at the exact release version and that its npm tarball is available, then writes the verified release marker to R2. `pi.dev/api/latest-version` reads that marker; it must never announce a release from npm before this job succeeds.

5. **If CI publish or announcement fails**: inspect the failed job. The publish helper is idempotent and skips package versions already present on npm; the announcement job rechecks availability before updating the R2 marker. Rerun the failed job or workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.
