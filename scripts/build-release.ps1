[CmdletBinding()]
param(
    [string]$SigningKey = (Join-Path $HOME ".tauri\wonkitch.key"),
    [string]$SigningPasswordFile = (Join-Path $HOME ".tauri\wonkitch.key.password"),
    [string]$Notes = "See the GitHub release notes for changes in this version."
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root "src-tauri\tauri.conf.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$version = $config.version
if (-not (Test-Path -LiteralPath $SigningKey)) {
    throw "Updater signing key not found at $SigningKey. Do not generate a replacement after publishing a release."
}
$publicKeyPath = "$SigningKey.pub"
if (-not (Test-Path -LiteralPath $publicKeyPath)) {
    throw "Updater public key not found at $publicKeyPath."
}
$localPublicKey = (Get-Content -LiteralPath $publicKeyPath -Raw).Trim()
if ($localPublicKey -ne $config.plugins.updater.pubkey) {
    throw "The signing key does not match the updater public key in tauri.conf.json."
}

$previousPrivateKey = $env:TAURI_SIGNING_PRIVATE_KEY
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
$previousRustFlags = $env:RUSTFLAGS
$signingPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
if (-not $signingPassword) {
    if (-not (Test-Path -LiteralPath $SigningPasswordFile)) {
        throw "Updater signing password not found. Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD or provide -SigningPasswordFile."
    }
    $securePassword = Get-Content -LiteralPath $SigningPasswordFile -Raw | ConvertTo-SecureString
    $credential = New-Object Management.Automation.PSCredential("wonkitch", $securePassword)
    $signingPassword = $credential.GetNetworkCredential().Password
}

$env:TAURI_SIGNING_PRIVATE_KEY = $SigningKey
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $signingPassword
$remapFlag = "--remap-path-prefix=$HOME=~"
$env:RUSTFLAGS = if ($previousRustFlags) { "$previousRustFlags $remapFlag" } else { $remapFlag }
try {
    & npm run tauri build -- --bundles nsis
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE."
    }
} finally {
    if ($null -eq $previousPrivateKey) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue } else { $env:TAURI_SIGNING_PRIVATE_KEY = $previousPrivateKey }
    if ($null -eq $previousPassword) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue } else { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword }
    if ($null -eq $previousRustFlags) { Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue } else { $env:RUSTFLAGS = $previousRustFlags }
    $signingPassword = $null
}

$releaseRoot = Join-Path $root "src-tauri\target\release"
$bundleRoot = Join-Path $releaseRoot "bundle\nsis"
$setupName = "wonkitch_${version}_x64-setup.exe"
$setupPath = Join-Path $bundleRoot $setupName
$signaturePath = "$setupPath.sig"
$assetDirectory = Join-Path $releaseRoot "release-assets"

foreach ($path in @($setupPath, $signaturePath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Expected release artifact not found: $path"
    }
}

if (Test-Path -LiteralPath $assetDirectory) {
    Remove-Item -LiteralPath $assetDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $assetDirectory | Out-Null

$releaseFiles = @(
    $setupPath,
    $signaturePath,
    (Join-Path $PSScriptRoot "install.ps1"),
    (Join-Path $PSScriptRoot "update.ps1")
)
foreach ($path in $releaseFiles) {
    Copy-Item -LiteralPath $path -Destination $assetDirectory
}

$signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
$latest = [ordered]@{
    version = $version
    notes = $Notes
    pub_date = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $signature
            url = "https://github.com/chrismacdonaldw/wonkitch/releases/latest/download/$setupName"
        }
    }
}
$latestJson = $latest | ConvertTo-Json -Depth 5
$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $assetDirectory "latest.json"), $latestJson, $utf8WithoutBom)

$hashLines = foreach ($file in Get-ChildItem -LiteralPath $assetDirectory -File | Sort-Object Name) {
    if ($file.Name -notin @("SHA256SUMS.txt", "latest.json")) {
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $($file.Name)"
    }
}
$hashLines | Set-Content -LiteralPath (Join-Path $assetDirectory "SHA256SUMS.txt") -Encoding ASCII

Write-Host "Prepared wonkitch $version release assets in $assetDirectory"
