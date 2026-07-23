<#
.SYNOPSIS
  Agent Workbench online installer (Windows).

.DESCRIPTION
  Downloads the standalone Windows binary from the latest GitHub release,
  verifies its SHA-256, installs it under %LOCALAPPDATA%\Programs\agent-workbench,
  and adds that directory to your user PATH.

  Run:
    irm https://raw.githubusercontent.com/rust-memo/agent-workbench/main/install.ps1 | iex

.NOTES
  Environment overrides:
    $env:AGENT_WORKBENCH_VERSION     = 'v0.1.0'   # pin a release (default: latest)
    $env:AGENT_WORKBENCH_INSTALL_DIR = 'C:\path'  # install location
    $env:AGENT_WORKBENCH_SKILLS_DIR  = 'C:\path'  # shipped skills location
    $env:AGENT_WORKBENCH_SKIP_SKILLS = '1'        # install binary only
    $env:AGENT_WORKBENCH_SKIP_CHECKSUM = '1'      # install without SHA-256 verification (unsafe)
    $env:AGENT_WORKBENCH_REPO        = 'owner/repo'
#>

#Requires -Version 5
$ErrorActionPreference = 'Stop'

$Repo = if ($env:AGENT_WORKBENCH_REPO) { $env:AGENT_WORKBENCH_REPO } else { 'rust-memo/agent-workbench' }
$Bin  = 'agent-workbench'
$AssetPrefix = 'agent-workbench'

# --- detect arch (only windows-x64 is published) -------------------------
if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'unsupported architecture: only 64-bit Windows (x64) is published.'
}
$asset = "$AssetPrefix-windows-x64.exe"

$requestedVersion = if ($env:AGENT_WORKBENCH_VERSION) { $env:AGENT_WORKBENCH_VERSION.Trim() } else { 'latest' }
if ($requestedVersion -ne 'latest' -and -not $requestedVersion.StartsWith('v')) {
  $requestedVersion = "v$requestedVersion"
}

if ($requestedVersion -eq 'latest') {
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing -ErrorAction Stop
    $ver = [string]$release.tag_name
  } catch {
    throw "could not resolve the latest release for $Repo`: $($_.Exception.Message)"
  }
  if ([string]::IsNullOrWhiteSpace($ver)) {
    throw "latest release metadata for $Repo has no tag_name"
  }
  Write-Host "resolved latest release -> $ver"
} else {
  $ver = $requestedVersion
}

if ($ver -notmatch '^[A-Za-z0-9._-]+$') {
  throw "invalid release tag '$ver'"
}
$base = "https://github.com/$Repo/releases/download/$ver"

$dir = if ($env:AGENT_WORKBENCH_INSTALL_DIR) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:AGENT_WORKBENCH_INSTALL_DIR)
} else {
  if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is not set; set AGENT_WORKBENCH_INSTALL_DIR explicitly.'
  }
  Join-Path $env:LOCALAPPDATA 'Programs\agent-workbench'
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  if ([Net.ServicePointManager]::SecurityProtocol -notmatch 'Tls12') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $download = Join-Path $tmp $asset

  Write-Host "downloading $asset ($ver)..."
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $download -UseBasicParsing -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $download) -or (Get-Item -LiteralPath $download).Length -eq 0) {
    throw "downloaded asset is empty: $base/$asset"
  }

  # --- verify checksum (required; fail-closed) ----------------------------
  # A self-updating binary must not install an unverified download. Any
  # failure to verify is fatal. Set $env:AGENT_WORKBENCH_SKIP_CHECKSUM='1' to
  # override (e.g. a mirror you trust by other means).
  if ($env:AGENT_WORKBENCH_SKIP_CHECKSUM -eq '1') {
    Write-Warning 'AGENT_WORKBENCH_SKIP_CHECKSUM=1 set - installing WITHOUT checksum verification'
  } else {
    try {
      $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing -ErrorAction Stop).Content
    } catch {
      throw "could not download SHA256SUMS from $base - refusing to install an unverified binary (set `$env:AGENT_WORKBENCH_SKIP_CHECKSUM='1' to override): $($_.Exception.Message)"
    }
    # Parse SHA256SUMS by exact filename. Each line is "<hex>  <name>"
    # (coreutils text mode) or "<hex> *<name>" (binary mode). Match the
    # filename field exactly rather than with a trailing-anchored regex:
    # the old `\s$asset\s*$` pattern was fragile against CRLF line endings
    # and the binary-mode '*' marker, which could reject a valid SHA256SUMS
    # and abort the install (#14).
    $want = $null
    foreach ($raw in ($sums -split "`r?`n")) {
      if ($raw.Trim() -notmatch '^([0-9A-Fa-f]{64})\s+\*?(.+)$') { continue }
      if ($matches[2].Trim() -eq $asset) {
        $want = $matches[1].ToLower()
        break
      }
    }
    if (-not $want) {
      $listed = (($sums -split "`r?`n") |
        ForEach-Object { if ($_ -match '^[0-9A-Fa-f]{64}\s+\*?(.+)$') { $matches[1].Trim() } } |
        Where-Object { $_ }) -join ', '
      throw "SHA256SUMS does not list $asset - refusing to install an unverified binary (listed: $listed). Set `$env:AGENT_WORKBENCH_SKIP_CHECKSUM='1' to override."
    }
    $got  = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower()
    if ($got -ne $want) {
      throw "checksum mismatch for $asset (expected $want, got $got)"
    }
    Write-Host 'checksum ok'
  }

  # --- stage shipped skills from the exact binary release ----------------
  # Staging happens before the executable is replaced, so a failed archive
  # download cannot leave a new binary paired with old or main-branch skills.
  $skillsDir = $null
  $skillsStage = $null
  $skillsBackup = $null
  if ($env:AGENT_WORKBENCH_SKIP_SKILLS -ne '1') {
    $skillsDir = if ($env:AGENT_WORKBENCH_SKILLS_DIR) {
      $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:AGENT_WORKBENCH_SKILLS_DIR)
    } else {
      Join-Path $env:USERPROFILE '.agent-workbench\builtin-skills'
    }

    $archiveUrl = "https://github.com/$Repo/archive/refs/tags/$ver.zip"
    $archive = Join-Path $tmp 'source.zip'
    Write-Host "downloading shipped skills ($ver)..."
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archive -UseBasicParsing -ErrorAction Stop

    $sourceRoot = Join-Path $tmp 'source'
    Expand-Archive -Path $archive -DestinationPath $sourceRoot -Force
    $skillsSrc = Get-ChildItem -Path $sourceRoot -Directory -Recurse |
      Where-Object { $_.Name -eq 'skills' } |
      Select-Object -First 1
    if (-not $skillsSrc) {
      throw "skills directory not found in the $ver source archive"
    }

    $skillsParent = Split-Path -Parent $skillsDir
    New-Item -ItemType Directory -Force -Path $skillsParent | Out-Null
    $skillsStage = "$skillsDir.tmp.$PID"
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $skillsStage
    New-Item -ItemType Directory -Force -Path $skillsStage | Out-Null
    Copy-Item -Recurse -Force -Path (Join-Path $skillsSrc.FullName '*') -Destination $skillsStage
  }

  $dest = Join-Path $dir "$Bin.exe"
  $staged = Join-Path $dir ".$Bin.tmp.$PID.exe"
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $staged
  Copy-Item -Force -Path $download -Destination $staged
  Move-Item -Force -LiteralPath $staged -Destination $dest
  Write-Host "installed $Bin -> $dest"

  # --- install shipped skills --------------------------------------------
  if ($skillsStage) {
    $skillsBackup = "$skillsDir.bak.$PID"
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $skillsBackup
    if (Test-Path -LiteralPath $skillsDir) {
      Move-Item -LiteralPath $skillsDir -Destination $skillsBackup
    }
    try {
      Move-Item -LiteralPath $skillsStage -Destination $skillsDir
      $skillsStage = $null
    } catch {
      if (Test-Path -LiteralPath $skillsBackup) {
        Move-Item -LiteralPath $skillsBackup -Destination $skillsDir
      }
      throw "failed to install shipped skills: $($_.Exception.Message)"
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $skillsBackup
    $skillsBackup = $null
    Write-Host "installed shipped skills ($ver) -> $skillsDir"
  }

  # --- add to user PATH --------------------------------------------------
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathEntries = @()
  if (-not [string]::IsNullOrWhiteSpace($userPath)) {
    $pathEntries = $userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  }

  if (-not ($pathEntries | Where-Object { [string]::Equals($_, $dir, [StringComparison]::OrdinalIgnoreCase) })) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $dir } else { "$userPath;$dir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$dir"
    Write-Host "added $dir to your user PATH (open a new terminal for it to take effect)"
  }

  & $dest --version
} finally {
  if ($skillsStage) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $skillsStage
  }
  if ($skillsBackup) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $skillsBackup
  }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
