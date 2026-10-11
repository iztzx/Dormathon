#Requires -Version 5.1
<#
.SYNOPSIS
Prepare and run OUT&IN's local, single-port synthetic demonstration.
.DESCRIPTION
Normal-user launcher for a trusted standalone checkout. Builds before backend
import. Never enables live integrations or real settlement. No global installs,
execution-policy changes, detached processes, or workspace deletion.
.EXAMPLE
& ./scripts/deploy_demo.ps1 -CopyKeyToClipboard
.EXAMPLE
& ./scripts/deploy_demo.ps1 -ReuseEnvironment -PrepareOnly
#>
[CmdletBinding()]
param(
    [string]$PythonExe = "",
    [string]$EnvironmentPath = "",
    [string]$WorkspacePath = "",
    [ValidateRange(1024, 65535)][int]$Port = 8000,
    [switch]$ReuseEnvironment,
    [switch]$ReuseWorkspace,
    [switch]$PrepareOnly,
    [switch]$ValidateOnly,
    [switch]$CopyKeyToClipboard
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
function Resolve-Canonical([string]$Path) {
    $Resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [IO.Path]::GetFullPath($Resolved).TrimEnd([char[]]"\/")
}
$Root = Resolve-Canonical (Join-Path $PSScriptRoot "..")
$Frontend = Join-Path $Root "frontend"
if (-not $EnvironmentPath) { $EnvironmentPath = Join-Path $Root ".venv" }
if (-not $WorkspacePath) { $WorkspacePath = Join-Path $Root "workspace" }
$EnvironmentPath = Resolve-Canonical $EnvironmentPath
$WorkspacePath = Resolve-Canonical $WorkspacePath
$Python = Join-Path $EnvironmentPath "Scripts/python.exe"
function Test-Within([string]$Child, [string]$Parent) {
    return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent + "\", [StringComparison]::OrdinalIgnoreCase)
}
function Assert-Location([string]$Path, [string]$AllowedDefault) {
    if ($Path.Equals($AllowedDefault, [StringComparison]::OrdinalIgnoreCase)) { return }
    if ((Test-Within $Path $Root) -or (Test-Within $Root $Path)) {
        throw "Choose the default dedicated directory or an external directory that does not contain the checkout: $Path"
    }
    if ([IO.Path]::GetPathRoot($Path).TrimEnd([char[]]"\/") -eq $Path) { throw "Do not select a drive root" }
}
function Assert-NoReparsePoint([string]$Path) {
    $Current = [IO.Path]::GetFullPath($Path)
    while ($Current) {
        if (Test-Path -LiteralPath $Current) {
            if (((Get-Item -LiteralPath $Current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing linked/junction path: $Current"
            }
        }
        $Parent = [IO.Directory]::GetParent($Current)
        if ($null -eq $Parent) { break }
        $Current = $Parent.FullName
    }
}
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $Executable" }
}
function Assert-Python313([string]$Executable, [string[]]$Prefix = @()) {
    Invoke-Checked $Executable (@($Prefix) + @("-c", "import sys; assert sys.version_info >= (3, 12), 'Use Python 3.12 or newer'"))
}
Assert-Location $EnvironmentPath (Resolve-Canonical (Join-Path $Root ".venv"))
Assert-Location $WorkspacePath (Resolve-Canonical (Join-Path $Root "workspace"))
if ((Test-Within $WorkspacePath $EnvironmentPath) -or (Test-Within $EnvironmentPath $WorkspacePath)) {
    throw "Environment and workspace must not overlap"
}
foreach ($Path in @($Root, $Frontend, (Join-Path $Frontend "node_modules"), (Join-Path $Frontend "dist"), $EnvironmentPath, $WorkspacePath, (Join-Path $Root "demo"))) { Assert-NoReparsePoint $Path }
# Validate concrete generation targets rather than following links under demo/.
foreach ($Relative in @("demo/models", "demo/dossier", "demo/dossier.zip", "demo/invoice.json", "demo/models/credit_classifier.pkl", "demo/models/credit_regressor.pkl", "demo/models/model_manifest.json", "demo/dossier/invoice.pdf", "demo/dossier/packing_list.pdf", "demo/dossier/statement.xlsx")) { Assert-NoReparsePoint (Join-Path $Root $Relative) }
foreach ($Relative in @("requirements.txt", "frontend/package-lock.json", "scripts/prepare_demo.py", "agent_service/app.py")) {
    $Path = Join-Path $Root $Relative
    Assert-NoReparsePoint $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing source file: $Relative" }
}
if ($env:OUT_IN_API_KEY -and $env:OUT_IN_API_KEY -cnotmatch '^[\x21-\x7E]{32,}$') {
    throw "OUT_IN_API_KEY must contain at least 32 printable ASCII characters without spaces"
}
if ((Test-Path -LiteralPath $WorkspacePath) -and -not $PrepareOnly) {
    if (-not (Test-Path -LiteralPath $WorkspacePath -PathType Container)) { throw "Workspace must be a directory" }
    if (-not $ReuseWorkspace) { throw "Workspace exists; stop all owning services and explicitly use -ReuseWorkspace. No files will be removed." }
}
$Node = (Get-Command "node.exe" -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$Npm = (Get-Command "npm.cmd" -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$VersionText = (& $Node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $VersionText -notmatch '^v(\d+)\.(\d+)\.(\d+)$' -or ([int]$Matches[1] -lt 22) -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 20)) { throw "Use Node 22.20 or newer; found $VersionText" }
$Prefix = @()
if ($ReuseEnvironment) {
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "No reusable environment at $EnvironmentPath" }
    Assert-Python313 $Python
} else {
    if (Test-Path -LiteralPath $EnvironmentPath) { throw "Environment exists; review it then use -ReuseEnvironment. It will not be overwritten." }
    if ($PythonExe) {
        $PythonExe = (Resolve-Path -LiteralPath $PythonExe -ErrorAction Stop).ProviderPath
        Assert-Python313 $PythonExe
    } else {
        $PythonExe = (Get-Command "py.exe" -CommandType Application -ErrorAction Stop).Source
        $Prefix = @("-3")
        Assert-Python313 $PythonExe $Prefix
    }
}
if ($ValidateOnly) {
    Write-Host "Preflight passed. No packages, files, workspace, keys or server were created."
    return
}
if (-not $PrepareOnly -and -not $env:OUT_IN_API_KEY -and -not $CopyKeyToClipboard) {
    throw "Supply a secure OUT_IN_API_KEY or explicitly use -CopyKeyToClipboard so you can enter the generated key in the browser"
}
# Source/workspace named locks coordinate instances of THIS launcher. Manual
# services must be stopped separately; these locks cannot detect arbitrary apps.
$Locks = @()
$SavedEnvironment = @{}
$Names = @("OUT_IN_API_KEY", "OUT_IN_MODE", "OUT_IN_REPO_ROOT", "OUT_IN_WORKSPACE", "OUT_IN_ALLOWED_ORIGINS", "OUT_IN_OCR_ADAPTER", "OUT_IN_OCR_ADAPTER_SHA256")
$Names += @([Environment]::GetEnvironmentVariables("Process").Keys | Where-Object { $_ -like "OUT_IN_MYINVOIS_*" })
$Names += "OUT_IN_MYINVOIS_ENABLED"
foreach ($Name in ($Names | Select-Object -Unique)) { $SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process") }
$PreviousLocation = Get-Location
try {
    foreach ($Path in @($Root, $WorkspacePath) | Sort-Object -Unique) {
        $Hash = [Security.Cryptography.SHA256]::Create()
        try { $Id = ([BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())))).Replace("-", "") } finally { $Hash.Dispose() }
        $Mutex = New-Object Threading.Mutex($false, ("Local\OUT_IN_" + $Id))
        $Acquired = $false
        try { $Acquired = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $Acquired = $true }
        if (-not $Acquired) { $Mutex.Dispose(); throw "Another launcher owns this source/workspace; stop it before preparation" }
        $Locks += $Mutex
    }
    if (-not $PrepareOnly) {
        $Probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
        try { $Probe.Start() } catch { throw "Port $Port is already occupied; refusing preparation/startup" } finally { $Probe.Stop() }
    }
    Set-Location -LiteralPath $Root
    if (-not $ReuseEnvironment) { Invoke-Checked $PythonExe (@($Prefix) + @("-m", "venv", $EnvironmentPath)) }
    if ($ReuseWorkspace -and (Test-Path -LiteralPath $WorkspacePath) -and -not $PrepareOnly) {
        # Fail closed on existing linked runtime descendants before backend import.
        Invoke-Checked $Python @("-c", "import os,sys; from pathlib import Path; root=Path(sys.argv[1]); assert not root.is_symlink() and not root.is_junction(); [(_ for _ in ()).throw(RuntimeError('Linked runtime path')) for d,dirs,files in os.walk(root,followlinks=False) for n in dirs+files if (Path(d)/n).is_symlink() or (Path(d)/n).is_junction()]", $WorkspacePath)
    }
    Invoke-Checked $Python @("-m", "pip", "install", "-r", (Join-Path $Root "requirements.txt"))
    Invoke-Checked $Python @("-m", "pip", "check")
    Set-Location -LiteralPath $Frontend
    Invoke-Checked $Npm @("ci", "--include=dev", "--no-audit", "--no-fund")
    Invoke-Checked $Npm @("run", "build")
    if (-not (Test-Path -LiteralPath (Join-Path $Frontend "dist/index.html") -PathType Leaf)) { throw "Frontend build did not create dist/index.html" }
    Set-Location -LiteralPath $Root
    Invoke-Checked $Python @((Join-Path $Root "scripts/prepare_demo.py"))
    if ($PrepareOnly) { Write-Host "Prepared synthetic assets and frontend. No backend was started."; return }
    if (-not $env:OUT_IN_API_KEY) {
        $Generated = & $Python -c "import secrets; print(secrets.token_urlsafe(32))"
        if ($LASTEXITCODE -ne 0) { throw "Operator key generation failed" }
        $env:OUT_IN_API_KEY = ($Generated -join "").Trim()
        $Generated = $null
    }
    foreach ($Name in ($Names | Select-Object -Unique)) {
        if ($Name -like "OUT_IN_MYINVOIS_*" -or $Name -like "OUT_IN_OCR_ADAPTER*") { [Environment]::SetEnvironmentVariable($Name, $null, "Process") }
    }
    $env:OUT_IN_MYINVOIS_ENABLED = "0"
    $env:OUT_IN_MODE = "demo"
    $env:OUT_IN_REPO_ROOT = $Root
    $env:OUT_IN_WORKSPACE = $WorkspacePath
    $env:OUT_IN_ALLOWED_ORIGINS = "http://127.0.0.1:$Port,http://localhost:$Port"
    if ($CopyKeyToClipboard) { Set-Clipboard -Value $env:OUT_IN_API_KEY; Write-Host "Key copied by explicit request. Clear clipboard/history after browser entry." }
    Write-Host "OUT&IN synthetic demo: http://127.0.0.1:$Port"
    Write-Host "Workspace: $WorkspacePath (sensitive evidence/private demo keys)."
    Write-Host "One worker; simulated settlement only. Stop with Ctrl+C after active jobs finish."
    Invoke-Checked $Python @("-m", "uvicorn", "agent_service.app:app", "--app-dir", $Root, "--host", "127.0.0.1", "--port", [string]$Port, "--workers", "1", "--no-access-log")
} finally {
    foreach ($Name in $SavedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], "Process") }
    for ($Index = $Locks.Count - 1; $Index -ge 0; $Index--) { $Locks[$Index].ReleaseMutex(); $Locks[$Index].Dispose() }
    Set-Location -LiteralPath $PreviousLocation.Path
}
