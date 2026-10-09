# Uninstall MATE: close running companions, remove the install directory and the PATH entry.
# Usage (PowerShell):
#   iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.ps1 -useb | iex
# The companion's state and memories in ~/.pi/agent/mate are KEPT - delete that
# directory yourself if you want them gone too.
$ErrorActionPreference = "Stop"

$InstallDir = if ($env:MATE_INSTALL_DIR) { $env:MATE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\mate" }

$Running = @(Get-Process mate -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)
})
if ($Running.Count -gt 0) {
    Write-Host "Closing running mate (pids: $($Running.Id -join ', '))..."
    $Running | ForEach-Object { $null = $_.CloseMainWindow() }
    Start-Sleep -Milliseconds 800
    $Running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
}

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
    Write-Host "Removed $InstallDir"
} else {
    Write-Host "Nothing to remove at $InstallDir"
}

# Drop the PATH entry the installer added (match the normalized path).
$DirNormalized = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath) {
    $Parts = @($UserPath -split ";" | Where-Object {
        $_ -and ($_.TrimEnd('\') -ne $DirNormalized)
    })
    [Environment]::SetEnvironmentVariable("Path", ($Parts -join ";"), "User")
    Write-Host "Removed $DirNormalized from your user PATH (takes effect in new terminals)."
}

Write-Host "mate uninstalled. Companion state in ~\.pi\agent\mate was kept; remove that directory too if you want everything gone."
