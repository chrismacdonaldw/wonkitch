[CmdletBinding()]
param(
    [string]$Repository = "chrismacdonaldw/wonkitch",
    [string]$Version = "latest",
    [switch]$Silent,
    [switch]$SkipStreamlink,
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

function Test-Streamlink {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Streamlink\bin\streamlink.exe"),
        (Join-Path $env:ProgramFiles "Streamlink\bin\streamlink.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Streamlink\bin\streamlink.exe")
    )
    return [bool]($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

function Install-StreamlinkIfNeeded {
    if ((Test-Streamlink) -or $SkipStreamlink) {
        return
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Warning "Streamlink was not found and winget is unavailable. Install Streamlink before using wonkitch."
        return
    }

    $install = $Silent
    if (-not $Silent) {
        $answer = Read-Host "Streamlink is required but was not found. Install it with winget now? [Y/n]"
        $install = -not $answer -or $answer -match "^[Yy]"
    }
    if (-not $install) {
        Write-Warning "wonkitch cannot play streams until Streamlink is installed."
        return
    }

    $arguments = @(
        "install", "--id", "Streamlink.Streamlink", "--exact",
        "--accept-package-agreements", "--accept-source-agreements"
    )
    if ($Silent) {
        $arguments += "--silent"
    }
    & winget @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "winget could not install Streamlink (exit code $LASTEXITCODE)."
    }
}

$release = Get-Release
$setupAssets = @($release.assets | Where-Object { $_.name -like "wonkitch_*_x64-setup.exe" })
if ($setupAssets.Count -ne 1) {
    throw "Release $($release.tag_name) does not contain exactly one x64 setup executable."
}
$assetName = $setupAssets[0].name
$asset = Find-Asset $release $assetName
$checksums = Find-Asset $release "SHA256SUMS.txt"
$temporary = Join-Path $env:TEMP "wonkitch-install-$PID"
New-Item -ItemType Directory -Path $temporary -Force | Out-Null

try {
    Write-Host "Downloading wonkitch $($release.tag_name)..."
    $download = Save-ReleaseAsset $release $asset $temporary
    $checksumFile = Save-ReleaseAsset $release $checksums $temporary
    Confirm-Checksum $download $checksumFile
    Install-StreamlinkIfNeeded

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
