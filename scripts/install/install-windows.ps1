<#
.SYNOPSIS
    Install Mirall from an MSIX package without going through App Installer.

.DESCRIPTION
    Double-clicking a .msix hands it to App Installer, which can fail for reasons that have
    nothing to do with the package - a stale App Installer (it updates via the Microsoft
    Store), or its refusal to install packages declaring certain restricted capabilities.
    Add-AppxPackage talks to the deployment stack directly and is subject to neither.

    This wraps Add-AppxPackage with the checks that make a failure legible: it verifies the
    signature, clears the mark-of-the-web, refuses to run from an elevated shell, and maps
    the common error codes to an actual next step.

.PARAMETER Path
    Path to the .msix. Defaults to the newest Mirall*.msix in the Downloads folder.

.PARAMETER Diagnose
    Collect an environment report instead of installing, and write it to
    %USERPROFILE%\mirall-windows-diagnose-<timestamp>.txt. Does not require -Path.

.PARAMETER AllowElevated
    Proceed even when running elevated. Add-AppxPackage installs per-user, so an elevated
    shell installs Mirall for the administrator account instead of yours.

.EXAMPLE
    .\scripts\install-windows.ps1

.EXAMPLE
    .\scripts\install-windows.ps1 -Path D:\builds\Mirall.msix

.EXAMPLE
    .\scripts\install-windows.ps1 -Diagnose

.NOTES
    Run from a NORMAL PowerShell window, not "Run as administrator".
#>

[CmdletBinding()]
param(
    [string]$Path,
    [switch]$Diagnose,
    [switch]$AllowElevated
)

$ErrorActionPreference = 'Continue'

$ExpectedRoot = 'Certum Trusted Network CA 2'

# Reported, never modified. wuauserv and DoSvc are here because update-blocking tools
# disable them, which is what starves App Installer of Store updates.
$RelevantServices = @(
    'AppXSvc',
    'StateRepository',
    'ClipSVC',
    'InstallService',
    'CryptSvc',
    'wuauserv',
    'DoSvc',
    'BITS'
)

$HResultHints = @{
    '0x800B0109' = "The signing certificate chain ends in a root this machine does not trust. " +
                   "Import '$ExpectedRoot' into Local Computer -> Trusted Root Certification Authorities."
    '0x80070005' = "Access denied. You are most likely in an elevated PowerShell - " +
                   "close it and run this from a normal window."
    '0x80073CF3' = "Dependency or conflict validation failed. An older Mirall may still be " +
                   "installed or partially staged; run scripts\uninstall-windows.ps1, then retry."
}

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-PackagePath {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "No file at: $Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    $found = Get-ChildItem -Path $downloads -Filter 'Mirall*.msix' -File -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending |
             Select-Object -First 1
    if (-not $found) { throw "No Mirall*.msix found in $downloads. Pass -Path <file>." }
    return $found.FullName
}

function Get-ChainReport {
    param([string]$File)

    $sig = Get-AuthenticodeSignature -LiteralPath $File
    $lines = @("Signature status : $($sig.Status)")
    if ($sig.StatusMessage) { $lines += "Status message   : $($sig.StatusMessage)" }

    if ($sig.SignerCertificate) {
        $lines += "Signer subject   : $($sig.SignerCertificate.Subject)"
        $lines += "Signer issuer    : $($sig.SignerCertificate.Issuer)"
        $lines += "Signer thumbprint: $($sig.SignerCertificate.Thumbprint)"
        $lines += "Not after        : $($sig.SignerCertificate.NotAfter)"

        $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
        $chain.ChainPolicy.RevocationMode = 'NoCheck'
        $built = $chain.Build($sig.SignerCertificate)
        $lines += "Chain builds     : $built"
        foreach ($el in $chain.ChainElements) {
            $status = ($el.ChainElementStatus | ForEach-Object { $_.Status }) -join ','
            if ($status) { $lines += "  - $($el.Certificate.Subject)  [$status]" }
            else         { $lines += "  - $($el.Certificate.Subject)" }
        }
    }

    $rootPresent = @(Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
                     Where-Object { $_.Subject -like "*$ExpectedRoot*" }).Count -gt 0
    $lines += "'$ExpectedRoot' in LocalMachine\Root: $rootPresent"

    return ,$lines
}

function Invoke-Diagnose {
    param([string]$File)

    $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
    $out    = Join-Path $env:USERPROFILE "mirall-windows-diagnose-$stamp.txt"
    $report = @()

    $report += "Mirall Windows install diagnostics - $(Get-Date -Format o)"
    $report += ("=" * 70)

    $report += "", "## Windows"
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    $report += "ProductName    : $($cv.ProductName)"
    $report += "DisplayVersion : $($cv.DisplayVersion)"
    $report += "Build          : $($cv.CurrentBuild).$($cv.UBR)"
    $report += "PowerShell     : $($PSVersionTable.PSVersion)"
    $report += "Elevated       : $(Test-Elevated)"

    $report += "", "## App Installer"
    $ai = Get-AppxPackage Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue
    if ($ai) { $report += "Version: $($ai.Version)  Status: $($ai.Status)" }
    else     { $report += "NOT INSTALLED - this alone explains a double-click failure." }

    $report += "", "## Mirall package"
    $mirall = Get-AppxPackage Mirall.Mirall -ErrorAction SilentlyContinue
    if ($mirall) { $report += "Installed: $($mirall.Version)  $($mirall.InstallLocation)" }
    else         { $report += "Not installed." }

    $report += "", "## Services (reported, not modified)"
    foreach ($name in $RelevantServices) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc) { $report += "{0,-16} StartType={1,-9} Status={2}" -f $name, $svc.StartType, $svc.Status }
        else      { $report += "{0,-16} (not present)" -f $name }
    }

    $report += "", "## Package file"
    if ($File) {
        $fi = Get-Item -LiteralPath $File
        $report += "Path   : $($fi.FullName)"
        $report += "Length : $($fi.Length)"
        $report += "SHA256 : $((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash)"
        $zone = Get-Item -LiteralPath $File -Stream Zone.Identifier -ErrorAction SilentlyContinue
        $report += "Mark-of-the-web present: $([bool]$zone)"
        $report += ""
        $report += Get-ChainReport -File $File
    } else {
        $report += "(no package file resolved - pass -Path to include signature details)"
    }

    $report += "", "## AppXDeploymentServer/Operational - last 40 events"
    $events = Get-WinEvent -LogName 'Microsoft-Windows-AppXDeploymentServer/Operational' `
                           -MaxEvents 40 -ErrorAction SilentlyContinue
    if ($events) {
        foreach ($e in $events) {
            $report += "[{0:u}] Id={1} {2}" -f $e.TimeCreated, $e.Id, ($e.Message -replace '\s+', ' ')
        }
    } else {
        $report += "(no events readable - the log may be empty or require elevation)"
    }

    $report += "", "## App Installer diagnostic output"
    $diagDir = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir'
    if (Test-Path $diagDir) {
        Get-ChildItem $diagDir -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 10 |
            ForEach-Object { $report += "{0,-50} {1,10}  {2:u}" -f $_.Name, $_.Length, $_.LastWriteTime }
        $report += "(directory: $diagDir)"
    } else {
        $report += "(no DiagOutputDir at $diagDir)"
    }

    $report | Set-Content -LiteralPath $out -Encoding UTF8

    Write-Host ""
    Write-Host "Diagnostics written to:" -ForegroundColor Cyan
    Write-Host "  $out"
    Write-Host ""
    Write-Host "Attach that file to your report. Review it first if you like - it contains no" -ForegroundColor Gray
    Write-Host "credentials, only Windows version, service states and package metadata." -ForegroundColor Gray
    Write-Host ""
}

Write-Host ""
Write-Host "Mirall Windows installer (Add-AppxPackage, bypassing App Installer)" -ForegroundColor Cyan
Write-Host ("=" * 70)

$pkgPath = $null
try {
    $pkgPath = Resolve-PackagePath -Explicit $Path
    Write-Host "Package: $pkgPath" -ForegroundColor Gray
} catch {
    if (-not $Diagnose) {
        Write-Host "ERROR: $_" -ForegroundColor Red
        exit 1
    }
    Write-Host "No package resolved - running diagnostics only." -ForegroundColor Gray
}

if ($Diagnose) {
    Invoke-Diagnose -File $pkgPath
    exit 0
}

if ((Test-Elevated) -and -not $AllowElevated) {
    Write-Host ""
    Write-Host "REFUSING: this shell is elevated." -ForegroundColor Red
    Write-Host "Add-AppxPackage installs per-user, so installing from an elevated shell puts" -ForegroundColor Yellow
    Write-Host "Mirall on the administrator account, not yours - it will not appear in your" -ForegroundColor Yellow
    Write-Host "Start menu. Open a normal PowerShell window and run this again." -ForegroundColor Yellow
    Write-Host "(Pass -AllowElevated if installing for the admin account is what you want.)" -ForegroundColor Gray
    exit 1
}

Write-Host "[1/4] Clearing mark-of-the-web..." -ForegroundColor Yellow
Unblock-File -LiteralPath $pkgPath -ErrorAction SilentlyContinue
Write-Host "      Done." -ForegroundColor Green

Write-Host "[2/4] Verifying signature..." -ForegroundColor Yellow
$sig = Get-AuthenticodeSignature -LiteralPath $pkgPath
if ($sig.Status -ne 'Valid') {
    Write-Host "      Signature status: $($sig.Status)" -ForegroundColor Red
    if ($sig.StatusMessage) { Write-Host "      $($sig.StatusMessage)" -ForegroundColor Red }
    Get-ChainReport -File $pkgPath | ForEach-Object { Write-Host "      $_" -ForegroundColor Gray }
    Write-Host ""
    Write-Host "      Continuing anyway - Add-AppxPackage gives the authoritative error." -ForegroundColor Gray
} else {
    Write-Host "      Valid: $($sig.SignerCertificate.Subject)" -ForegroundColor Green
}

Write-Host "[3/4] Existing install..." -ForegroundColor Yellow
$existing = Get-AppxPackage Mirall.Mirall -ErrorAction SilentlyContinue
if ($existing) { Write-Host "      Present: $($existing.Version) - will be upgraded in place." -ForegroundColor Gray }
else           { Write-Host "      None - fresh install." -ForegroundColor Gray }

Write-Host "[4/4] Installing..." -ForegroundColor Yellow
try {
    Add-AppxPackage -Path $pkgPath -ForceApplicationShutdown -ErrorAction Stop
    $now = Get-AppxPackage Mirall.Mirall -ErrorAction SilentlyContinue
    Write-Host "      Installed: $($now.Version)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Done. Mirall is in your Start menu." -ForegroundColor Cyan
    Write-Host ""
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Host "      FAILED." -ForegroundColor Red
    Write-Host ""
    Write-Host $message -ForegroundColor Red

    $code = ([regex]::Match($message, '0x[0-9A-Fa-f]{8}')).Value
    if ($code) {
        $key = '0x' + $code.Substring(2).ToUpper()
        if ($HResultHints.ContainsKey($key)) {
            Write-Host ""
            Write-Host "  -> $($HResultHints[$key])" -ForegroundColor Yellow
        }
    }

    Write-Host ""
    Write-Host "For a full report to attach to a bug report, run:" -ForegroundColor Cyan
    Write-Host "  .\scripts\install-windows.ps1 -Diagnose" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}
