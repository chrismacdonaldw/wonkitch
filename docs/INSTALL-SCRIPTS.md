# PowerShell Installation and Updates

Each GitHub release includes optional `install.ps1` and `update.ps1` scripts for
automated installation, explicit version selection, and private forks. Most users
can use the Windows installer or wonkitch's built-in updater instead.

## Verification

Before running an installer, both scripts:

- Download the installer, its updater signature, and `SHA256SUMS.txt` from the selected release
- Verify the installer SHA-256 checksum
- Download the pinned Minisign verifier and verify its checksum
- Verify the installer against wonkitch's pinned updater public key
- Remove temporary downloads after completion

This updater signature is separate from Authenticode. Windows SmartScreen may
still identify the installer as coming from an unknown publisher.

## Install

Install the latest release and launch wonkitch:

```powershell
.\install.ps1
```

Install without installer prompts and do not launch afterward:

```powershell
.\install.ps1 -Silent -NoLaunch
```

Select a specific release with `-Version "vX.Y.Z"`.

## Update

Update only when the selected release is newer than the installed version:

```powershell
.\update.ps1
```

Run unattended without launching wonkitch afterward:

```powershell
.\update.ps1 -Silent -NoLaunch
```

`-Force` reinstalls the selected release even if its version is not newer.
`update.ps1` also performs an installation when wonkitch is not already installed.

## Private Forks

Use `-Repository "owner/repository"` to select another GitHub repository. For a
private repository, authenticate with `gh auth login`, set `GITHUB_TOKEN`, or pass
`-GitHubToken` directly.

The selected release must contain exactly one `wonkitch_*_x64-setup.exe` asset,
its matching `.sig` file, and `SHA256SUMS.txt`. A fork that changes the updater
key must also change the public key pinned in both scripts and the Tauri updater
configuration.
