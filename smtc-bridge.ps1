# ═══════════════════════════════════════════════════════════════════════
#  SMTC BRIDGE
#
#  Reads the Windows System Media Transport Controls (SMTC) "now playing"
#  session via the Windows.Media.Control WinRT API and prints one compact
#  JSON line to stdout whenever the track/state changes (plus a ~1s heartbeat).
#  main.js spawns this with powershell.exe and forwards each line to the
#  renderer over the "smtc-update" IPC channel.
#
#  Emitted shape (one JSON object per line):
#    { "source":"smtc", "status":"playing|paused|stopped|none",
#      "title":"", "artist":"", "album":"",
#      "positionMs":<num>, "durationMs":<num>, "rate":<num>, "updatedMs":<epoch ms> }
#
#  Notes:
#   - SMTC timeline Position is a SNAPSHOT reported by the source app (updated
#     on play/pause/seek, not continuously). We emit Position + updatedMs + rate
#     so the renderer can interpolate live milliseconds between updates.
#   - Designed for Windows PowerShell 5.1 (the powershell.exe main.js launches).
# ═══════════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ── WinRT IAsyncOperation -> awaitable bridge for PowerShell 5.1 ──────────
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

# Force-load the WinRT projections we need.
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

$mgr = Await ($mgrType::RequestAsync()) $mgrType

function Write-Line($obj) {
  $json = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function To-EpochMs($dto) {
  # $dto is a DateTimeOffset; guard against default/min values some apps report.
  try {
    if ($dto.Year -lt 1972) { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    return $dto.ToUnixTimeMilliseconds()
  } catch {
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

$lastSig = ""
$lastEmit = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

while ($true) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  try {
    $session = $mgr.GetCurrentSession()

    if ($null -eq $session) {
      $sig = "none"
      if ($sig -ne $lastSig -or ($now - $lastEmit) -ge 1000) {
        Write-Line ([ordered]@{ source = "smtc"; status = "none" })
        $lastSig = $sig; $lastEmit = $now
      }
      Start-Sleep -Milliseconds 300
      continue
    }

    $title = ""; $artist = ""; $album = ""
    try {
      $props = Await ($session.TryGetMediaPropertiesAsync()) $propType
      if ($props) {
        $title = [string]$props.Title
        $artist = [string]$props.Artist
        $album = [string]$props.AlbumTitle
      }
    } catch { }

    $positionMs = 0.0; $durationMs = 0.0; $updatedMs = $now
    try {
      $tl = $session.GetTimelineProperties()
      $positionMs = [double]$tl.Position.TotalMilliseconds
      $durationMs = [double]$tl.EndTime.TotalMilliseconds
      $updatedMs = To-EpochMs $tl.LastUpdatedTime
    } catch { }

    $status = "stopped"; $rate = 1.0
    try {
      $pb = $session.GetPlaybackInfo()
      $status = ([string]$pb.PlaybackStatus).ToLower()  # playing|paused|stopped|...
      if ($null -ne $pb.PlaybackRate) { $rate = [double]$pb.PlaybackRate }
    } catch { }

    # Emit on track/state change, or as a ~1s heartbeat (so interpolation
    # re-anchors and the renderer notices play/pause promptly).
    $sig = "$title|$artist|$status"
    if ($sig -ne $lastSig -or ($now - $lastEmit) -ge 1000) {
      Write-Line ([ordered]@{
        source     = "smtc"
        status     = $status
        title      = $title
        artist     = $artist
        album      = $album
        positionMs = [math]::Round($positionMs)
        durationMs = [math]::Round($durationMs)
        rate       = $rate
        updatedMs  = $updatedMs
      })
      $lastSig = $sig; $lastEmit = $now
    }
  } catch {
    # Never let a transient WinRT hiccup kill the loop.
    if (($now - $lastEmit) -ge 1000) {
      Write-Line ([ordered]@{ source = "smtc"; status = "none" })
      $lastEmit = $now
    }
  }
  Start-Sleep -Milliseconds 250
}
