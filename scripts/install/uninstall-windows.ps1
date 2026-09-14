<#
.SYNOPSIS
    Fully uninstall Mirall from a Windows machine and wipe all local state.

.DESCRIPTION
    Removes the MSIX package and any data Mirall writes outside the package
    sandbox, returning the machine to a clean-slate state for testing a new
    build. Use between beta installs to make sure no stale runtime data from
    a previous version interferes with the new install.

    What this removes:
      1. The Mirall.Mirall AppX package (and Windows-managed package state
         under %LOCALAPPDATA%\Packages\Mirall.Mirall_<hash>\)
      2. Belt-and-braces removal of any Mirall.Mirall_* package state folders
         in case Remove-AppxPackage leaves anything behind
      3. Electron userData / cache from unpackaged dev runs:
           %APPDATA%\Mirall\
           %LOCALAPPDATA%\Mirall\
      4. Legacy paths from the old appling-era install (harmless if absent):
           %APPDATA%\pear\
           %USERPROFILE%\mirall-install.log

.PARAMETER KeepLog
    If specified, the legacy debug log at %USERPROFILE%\mirall-install.log
    is NOT deleted. Useful when keeping a record of a failed install across
    cleanup cycles.

.EXAMPLE
    .\scripts\uninstall-windows.ps1
    Full clean - uninstalls Mirall and removes all local state.

.NOTES
    Safe to run when Mirall is not installed - every step uses
    -ErrorAction SilentlyContinue so missing files/packages are not errors.
#>

[CmdletBinding()]
param(
    [switch]$KeepLog
)

$ErrorActionPreference = 'Continue'

Write-Host ""
Write-Host "Mirall cleanup - removing package and local state" -ForegroundColor Cyan
Write-Host ("=" * 55)

# 1. Uninstall the AppX package
$pkg = Get-AppxPackage Mirall.Mirall -ErrorAction SilentlyContinue
if ($pkg) {
    Write-Host "[1/5] Uninstalling Mirall.Mirall ($($pkg.PackageFamilyName))..." -ForegroundColor Yellow
    $pkg | Remove-AppxPackage
    Write-Host "      Done." -ForegroundColor Green
} else {
    Write-Host "[1/5] No Mirall.Mirall package installed - skipping uninstall." -ForegroundColor Gray
}

# 2. Belt-and-braces removal of Mirall.Mirall_* package state folders
$packageStateDirs = Get-ChildItem -Path "$env:LOCALAPPDATA\Packages" -Directory -Filter "Mirall.Mirall_*" -ErrorAction SilentlyContinue
if ($packageStateDirs) {
    foreach ($dir in $packageStateDirs) {
        Write-Host "[2/5] Removing leftover package state: $($dir.FullName)" -ForegroundColor Yellow
        Remove-Item $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "      Done." -ForegroundColor Green
} else {
    Write-Host "[2/5] No leftover package state under %LOCALAPPDATA%\Packages - skipping." -ForegroundColor Gray
}

# 3. Electron userData under %APPDATA%\Mirall\
#    Lives here when Mirall is launched as an unpackaged build (out\Mirall-win32-x64\Mirall.exe)
#    rather than the MSIX. MSIX-installed Mirall writes inside the package sandbox
#    (covered by step 2).
$appData = "$env:APPDATA\Mirall"
if (Test-Path $appData) {
    Write-Host "[3/5] Removing %APPDATA%\Mirall (Electron userData)..." -ForegroundColor Yellow
    Remove-Item $appData -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "      Done." -ForegroundColor Green
} else {
    Write-Host "[3/5] No %APPDATA%\Mirall - skipping." -ForegroundColor Gray
}

# 4. Electron caches under %LOCALAPPDATA%\Mirall\
$localAppData = "$env:LOCALAPPDATA\Mirall"
if (Test-Path $localAppData) {
    Write-Host "[4/5] Removing %LOCALAPPDATA%\Mirall (Electron cache)..." -ForegroundColor Yellow
    Remove-Item $localAppData -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "      Done." -ForegroundColor Green
} else {
    Write-Host "[4/5] No %LOCALAPPDATA%\Mirall - skipping." -ForegroundColor Gray
}

# 5. Legacy paths from the old appling-era install
$legacyPear = "$env:APPDATA\pear"
$logPath = "$env:USERPROFILE\mirall-install.log"
$cleanedLegacy = $false
if (Test-Path $legacyPear) {
    Write-Host "[5/5] Removing legacy %APPDATA%\pear (appling-era)..." -ForegroundColor Yellow
    Remove-Item $legacyPear -Recurse -Force -ErrorAction SilentlyContinue
    $cleanedLegacy = $true
}
if (-not $KeepLog -and (Test-Path $logPath)) {
    Write-Host "[5/5] Removing legacy debug log: $logPath" -ForegroundColor Yellow
    Remove-Item $logPath -ErrorAction SilentlyContinue
    $cleanedLegacy = $true
}
if (-not $cleanedLegacy) {
    Write-Host "[5/5] No legacy appling-era files - skipping." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Cleanup complete. Machine is in a clean-slate state for a fresh install." -ForegroundColor Cyan
Write-Host ""
