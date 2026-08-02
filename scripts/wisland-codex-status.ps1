param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("completed", "failed")]
  [string]$Phase,

  [int]$MinimumRunningVisibleMs = 800
)

$ErrorActionPreference = "Stop"
$statusDirectory = if ($env:APPDATA) {
  Join-Path $env:APPDATA "wisland"
} else {
  Join-Path $env:LOCALAPPDATA "wisland"
}
$statusPath = Join-Path $statusDirectory "codex-status.json"
$runningPath = Join-Path $statusDirectory "codex-running.flag"
$holdPath = Join-Path $statusDirectory "codex-running-hold.flag"

New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$visibleUntil = 0

if (Test-Path -LiteralPath $runningPath) {
  $startedAt = ([DateTimeOffset](Get-Item -LiteralPath $runningPath).LastWriteTimeUtc).ToUnixTimeMilliseconds()
  $remainingMs = [Math]::Max(0, $MinimumRunningVisibleMs - ($now - $startedAt))
  if ($remainingMs -gt 0) {
    $visibleUntil = $now + $remainingMs
  }
}

Remove-Item -LiteralPath $runningPath -Force -ErrorAction SilentlyContinue
if ($visibleUntil -gt $now) {
  [System.IO.File]::WriteAllText($holdPath, [string]$visibleUntil, [System.Text.UTF8Encoding]::new($false))
} else {
  Remove-Item -LiteralPath $holdPath -Force -ErrorAction SilentlyContinue
}

$status = [ordered]@{
  phase = $Phase
  updatedAt = $now
}
$json = $status | ConvertTo-Json -Compress
$temporaryPath = "$statusPath.tmp"
[System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force

[Console]::Out.Write('{"continue":true,"suppressOutput":true}')
