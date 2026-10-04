# Install or update Persisto Mate (mate.exe) and add it to your user PATH. No admin needed.
# Usage (PowerShell):
#   iwr https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.ps1 -useb | iex
# Re-running it updates in place. Running mate processes are closed first: Windows
# refuses to delete a native module (native/win32/.../win32-platform.node) that a live
# process has loaded, which previously made an update fail with a cryptic access error.
$ErrorActionPreference = "Stop"

$Repo = "m-rui001/Persisto-Mate"

$Arch = $env:PROCESSOR_ARCHITECTURE
if ($Arch -eq "ARM64") { $platform = "windows-arm64" } else { $platform = "windows-x64" }

$InstallDir = if ($env:MATE_INSTALL_DIR) { $env:MATE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\mate" }
$Url = "https://github.com/$Repo/releases/latest/download/mate-$platform.zip"

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

Write-Host "Downloading mate for $platform..."
$Tmp = New-TemporaryFile
$Zip = "$Tmp.zip"; Remove-Item $Tmp
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

    $Verb = if (Test-Path $InstallDir) { "Updating" } else { "Installing" }
    Write-Host "$Verb in $InstallDir..."
    try {
        if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    } catch {
        Write-Host ""
        Write-Host "Cannot remove $InstallDir - mate may still be running, or a file is locked." -ForegroundColor Yellow
        Write-Host "Close all mate windows and re-run this command." -ForegroundColor Yellow
        throw
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Expand-Archive -Path $Zip -DestinationPath $InstallDir -Force

    # Put the directory holding mate.exe on the user PATH (idempotent).
    $Dir = (Resolve-Path $InstallDir).Path
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Parts = @()
    if ($UserPath) { $Parts = $UserPath -split ";" | Where-Object { $_ -and ($_ -ne $Dir) } }
    [Environment]::SetEnvironmentVariable("Path", (($Parts + $Dir) -join ";"), "User")
    if (($env:Path -split ";") -notcontains $Dir) { $env:Path = "$env:Path;$Dir" }

    & (Join-Path $Dir "mate.exe") --version | ForEach-Object { Write-Host "Installed: mate $_" }
    Write-Host "Open a NEW terminal, then run: mate"
} finally {
    Remove-Item $Zip -ErrorAction SilentlyContinue
}
