# Releasing

This is the maintainer runbook for producing and publishing a wonkitch release.
Release assets should be treated as immutable after publication. Corrections ship
under a new version rather than replacing an existing tag or asset.

## Version

Keep the version synchronized in:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

## Preflight

Run all checks before creating release assets:

```powershell
npm ci
npm run prepare:streamlink
npm run build
cd src-tauri
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cd ..
```

Review `git status`, the complete diff, and recent commits. Commit only the files
intended for the release.

## Updater Signing

The release builder expects the existing updater key and its Windows-encrypted
password at:

- `%USERPROFILE%\.tauri\wonkitch.key`
- `%USERPROFILE%\.tauri\wonkitch.key.password`

The matching public key must exist at `wonkitch.key.pub` and match the key pinned
in `src-tauri/tauri.conf.json`.

Back up the private key and encrypted password securely. Never commit or
distribute them, and do not generate a replacement after shipping signed updates.
Existing installations cannot trust updates signed by a different key.

Updater signing does not Authenticode-sign the Windows installer. Authenticode is
a separate certificate-based process and is not currently configured.

## Build Assets

Generate the NSIS installer, updater signature, manifest, checksums, and
PowerShell scripts:

```powershell
.\scripts\build-release.ps1 -Notes "Summary of this release"
```

The complete upload set is written to
`src-tauri/target/release/release-assets/`:

- `wonkitch_<version>_x64-setup.exe`
- `wonkitch_<version>_x64-setup.exe.sig`
- `latest.json`
- `SHA256SUMS.txt`
- `install.ps1`
- `update.ps1`

`build-release.ps1` confirms that the signing key matches the public updater key
before building. It also performs a clean dependency install and forces a fresh
verification of the pinned Streamlink archive.

## Verify Assets

Before publication:

1. Confirm all expected assets exist and `latest.json` contains the intended version, notes, URL, and signature.
2. Verify every file listed in `SHA256SUMS.txt` against its recorded hash.
3. Install the previous public release and exercise the new installer in update mode.
4. Confirm the old app exits, no app starts immediately, and the updated app starts after the delayed relaunch.
5. Confirm preferences, Twitch account metadata, credentials, and the last channel survive the update.
6. Confirm bundled playback uses `pythonw.exe` and does not create console-host processes.
7. Test `install.ps1` and `update.ps1` against stopped and running installations.

## Publish

Create an annotated version tag only after the tested source is committed:

```powershell
git tag -a vX.Y.Z -m "wonkitch vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Create the GitHub release with all six files from `release-assets/`. After upload,
verify the release is public, not a draft or prerelease, and resolves as the
repository's latest release. Download the public assets again and compare their
SHA-256 hashes with the local files.

Finally, exercise the public `update.ps1` and public installer signature rather
than relying only on locally generated assets.

## Updating Streamlink

When changing the pinned Streamlink build:

1. Update the build/version, archive filename, archive size, archive hash, and URL in `scripts/prepare-streamlink.ps1`.
2. Update the versioned resource path in `src-tauri/tauri.conf.json`.
3. Update `STREAMLINK_RESOURCE` in `src-tauri/src/lib.rs`.
4. Add only explicitly retired runtime directories to post-install cleanup in `src-tauri/windows/installer-hooks.nsh` when cleanup is necessary.
5. Review third-party notices and licenses for the new runtime.
6. Run a forced preparation and the full playback/update process-tree tests.

Do not add a system Streamlink fallback. The application is designed to use only
the pinned private runtime bundled with the release.
