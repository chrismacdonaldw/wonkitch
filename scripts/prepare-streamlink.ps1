[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$streamlinkBuild = "8.5.0-1"
$streamlinkVersion = "8.5.0"
$archiveName = "streamlink-8.5.0-1-py314-x86_64.zip"
$archiveSize = 82901359
$archiveHash = "86409E93774EC59928ED289D291C48766F9C7535EA41085255404F219875B5F3"
$archiveUrl = "https://github.com/streamlink/windows-builds/releases/download/$streamlinkBuild/$archiveName"

$root = Split-Path -Parent $PSScriptRoot
$resourcesRoot = Join-Path $root "src-tauri\resources"
$destination = Join-Path $resourcesRoot "streamlink-$streamlinkBuild"
$marker = Join-Path $destination ".wonkitch-streamlink"
$streamlink = Join-Path $destination "bin\streamlink.exe"
$cacheRoot = Join-Path $env:LOCALAPPDATA "wonkitch-build-cache"
$archive = Join-Path $cacheRoot $archiveName

if (-not $Force -and (Test-Path -LiteralPath $streamlink) -and (Test-Path -LiteralPath $marker)) {
    if ((Get-Content -LiteralPath $marker -Raw).Trim() -eq $archiveHash) {
        $reportedVersion = (& $streamlink --no-config --no-plugin-sideloading --version 2>&1 | Out-String).Trim()
        $unexpectedFfmpeg = @(Get-ChildItem -LiteralPath $destination -Recurse -Filter "ffmpeg.exe" -File)
        if ($LASTEXITCODE -eq 0 -and $reportedVersion -eq "streamlink $streamlinkVersion" -and -not $unexpectedFfmpeg.Count) {
            Write-Host "Bundled Streamlink $streamlinkBuild is ready."
            exit 0
        }
    }
}

foreach ($directory in @($resourcesRoot, $cacheRoot)) {
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
}

$downloadRequired = -not (Test-Path -LiteralPath $archive)
if (-not $downloadRequired) {
    $item = Get-Item -LiteralPath $archive
    $downloadRequired = $item.Length -ne $archiveSize -or
        (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash
}
if ($downloadRequired) {
    Write-Host "Downloading verified Streamlink $streamlinkBuild portable runtime..."
    $partial = "$archive.partial"
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $archiveUrl -OutFile $partial -UseBasicParsing
    Move-Item -LiteralPath $partial -Destination $archive -Force
}

$archiveItem = Get-Item -LiteralPath $archive
if ($archiveItem.Length -ne $archiveSize) {
    throw "Streamlink archive size mismatch. Expected $archiveSize bytes but received $($archiveItem.Length)."
}
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($actualHash -ne $archiveHash) {
    throw "Streamlink archive checksum mismatch. Expected $archiveHash but received $actualHash."
}

$temporary = Join-Path $resourcesRoot ".streamlink-$streamlinkBuild-$PID"
Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    Expand-Archive -LiteralPath $archive -DestinationPath $temporary -Force
    $extractedStreamlink = Join-Path $temporary "bin\streamlink.exe"
    if (-not (Test-Path -LiteralPath $extractedStreamlink)) {
        $children = @(Get-ChildItem -LiteralPath $temporary -Directory)
        if ($children.Count -ne 1) {
            throw "The Streamlink archive has an unexpected directory layout."
        }
        $extractedRoot = $children[0].FullName
        $extractedStreamlink = Join-Path $extractedRoot "bin\streamlink.exe"
    } else {
        $extractedRoot = $temporary
    }

    foreach ($required in @(
        $extractedStreamlink,
        (Join-Path $extractedRoot "Python\python.exe"),
        (Join-Path $extractedRoot "LICENSE.txt")
    )) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "The Streamlink archive is missing required file $required."
        }
    }

    # Twitch's HTTP stream transport does not invoke FFmpeg, so do not ship the unused GPL runtime.
    Remove-Item -LiteralPath (Join-Path $extractedRoot "ffmpeg") -Recurse -Force -ErrorAction SilentlyContinue
    $reportedVersion = (& $extractedStreamlink --no-config --no-plugin-sideloading --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne "streamlink $streamlinkVersion") {
        throw "Prepared Streamlink failed validation: $reportedVersion"
    }

    [IO.File]::WriteAllText(
        (Join-Path $extractedRoot ".wonkitch-streamlink"),
        $archiveHash,
        [Text.Encoding]::ASCII
    )
    Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    if ($extractedRoot -eq $temporary) {
        Move-Item -LiteralPath $temporary -Destination $destination
    } else {
        Move-Item -LiteralPath $extractedRoot -Destination $destination
    }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Prepared Streamlink $streamlinkBuild at $destination"
