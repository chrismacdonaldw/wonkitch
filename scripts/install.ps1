[CmdletBinding()]
param(
    [string]$Repository = "chrismacdonaldw/wonkitch",
    [string]$Version = "latest",
    [switch]$Silent,
    [switch]$NoLaunch,
    [string]$GitHubToken = $env:GITHUB_TOKEN
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:UseGitHubCli = $false
$script:ApiHeaders = @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "wonkitch-installer"
}
if ($GitHubToken) {
    $script:ApiHeaders.Authorization = "Bearer $GitHubToken"
}

function Get-Release {
    $tag = $Version
    if ($tag -ne "latest" -and -not $tag.StartsWith("v")) {
        $tag = "v$tag"
    }
    $path = if ($tag -eq "latest") {
        "repos/$Repository/releases/latest"
    } else {
        "repos/$Repository/releases/tags/$tag"
    }

    try {
        return Invoke-RestMethod -Uri "https://api.github.com/$path" -Headers $script:ApiHeaders
    } catch {
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
            throw "Could not access the GitHub release. For a private repository, authenticate with gh or set GITHUB_TOKEN. $($_.Exception.Message)"
        }
        $json = & gh api $path 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Could not access the GitHub release through gh: $json"
        }
        $script:UseGitHubCli = $true
        return ($json | ConvertFrom-Json)
    }
}

function Save-ReleaseAsset {
    param($Release, $Asset, [string]$Directory)

    if ($script:UseGitHubCli) {
        & gh release download $Release.tag_name --repo $Repository --pattern $Asset.name --dir $Directory --clobber
        if ($LASTEXITCODE -ne 0) {
            throw "Could not download $($Asset.name) through gh."
        }
        return Join-Path $Directory $Asset.name
    }

    $headers = @{
        Accept = "application/octet-stream"
        "User-Agent" = "wonkitch-installer"
    }
    if ($GitHubToken) {
        $headers.Authorization = "Bearer $GitHubToken"
    }
    $destination = Join-Path $Directory $Asset.name
    Invoke-WebRequest -Uri $Asset.url -Headers $headers -OutFile $destination -UseBasicParsing
    return $destination
}

function Find-Asset {
    param($Release, [string]$Name)
    $matches = @($Release.assets | Where-Object { $_.name -eq $Name })
    if ($matches.Count -ne 1) {
        throw "Release $($Release.tag_name) does not contain exactly one $Name asset."
    }
    return $matches[0]
}

function Confirm-Checksum {
    param([string]$FilePath, [string]$ChecksumPath)
    $name = [IO.Path]::GetFileName($FilePath)
    $line = Get-Content -LiteralPath $ChecksumPath | Where-Object { $_ -match "^[A-Fa-f0-9]{64}\s+\*?$([regex]::Escape($name))$" }
    if (-not $line) {
        throw "SHA256SUMS.txt does not contain a checksum for $name."
    }
    $expected = ($line -split "\s+")[0].ToUpperInvariant()
    $actual = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actual -ne $expected) {
        throw "Checksum verification failed for $name. Expected $expected but received $actual."
    }
    Write-Host "Verified $name ($actual)"
}

function Confirm-ReleaseSignature {
    param([string]$FilePath, [string]$SignaturePath, [string]$Directory)
    $minisignUrl = "https://github.com/jedisct1/minisign/releases/download/0.12/minisign-0.12-win64.zip"
    $minisignHash = "37B600344E20C19314B2E82813DB2BFDCC408B77B876F7727889DBD46D539479"
    $publicKey = "RWSHvz9UfZ2mgeIZMbzVindyLHAaGR9Ab/UU86PQuCTHSalWLKith7YG"
    $archive = Join-Path $Directory "minisign-0.12-win64.zip"
    Invoke-WebRequest -Uri $minisignUrl -OutFile $archive -UseBasicParsing
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $minisignHash) {
        throw "Minisign verifier checksum mismatch. Expected $minisignHash but received $actualHash."
    }
    $tools = Join-Path $Directory "signature-tools"
    Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
    $decodedSignature = Join-Path $Directory "installer.minisig"
    $encodedSignature = (Get-Content -LiteralPath $SignaturePath -Raw).Trim()
    [IO.File]::WriteAllBytes($decodedSignature, [Convert]::FromBase64String($encodedSignature))
    $minisign = Join-Path $tools "minisign-win64\x86_64\minisign.exe"
    $verification = & $minisign -Vm $FilePath -x $decodedSignature -P $publicKey 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "The wonkitch updater signature is invalid: $verification"
    }
    Write-Host "Verified the wonkitch updater signature."
}

$release = Get-Release
$setupAssets = @($release.assets | Where-Object { $_.name -like "wonkitch_*_x64-setup.exe" })
if ($setupAssets.Count -ne 1) {
    throw "Release $($release.tag_name) does not contain exactly one x64 setup executable."
}
$assetName = $setupAssets[0].name
$asset = Find-Asset $release $assetName
$signature = Find-Asset $release "$assetName.sig"
$checksums = Find-Asset $release "SHA256SUMS.txt"
$temporary = Join-Path $env:TEMP "wonkitch-install-$PID"
New-Item -ItemType Directory -Path $temporary -Force | Out-Null

try {
    Write-Host "Downloading wonkitch $($release.tag_name)..."
    $download = Save-ReleaseAsset $release $asset $temporary
    $signatureFile = Save-ReleaseAsset $release $signature $temporary
    $checksumFile = Save-ReleaseAsset $release $checksums $temporary
    Confirm-Checksum $download $checksumFile
    Confirm-ReleaseSignature $download $signatureFile $temporary

    $installerArguments = @()
    if ($Silent) {
        $installerArguments += "/S"
    }
    $startOptions = @{ FilePath = $download; Wait = $true; PassThru = $true }
    if ($installerArguments.Count) {
        $startOptions.ArgumentList = $installerArguments
    }
    $process = Start-Process @startOptions
    if ($process.ExitCode -ne 0) {
        throw "wonkitch setup exited with code $($process.ExitCode)."
    }
    $executable = Join-Path $env:LOCALAPPDATA "wonkitch\wonkitch.exe"
    Write-Host "Installed wonkitch $($release.tag_name)."

    if (-not $NoLaunch -and (Test-Path -LiteralPath $executable)) {
        Start-Process -FilePath $executable
    }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
