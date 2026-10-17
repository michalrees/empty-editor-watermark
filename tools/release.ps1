<# Build/check/package only. Upload the generated VSIX using Marketplace > Update.
-DryRun is retained for compatibility; both modes prepare without publishing.
#>
[CmdletBinding()]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    & node tools/prepare-release.cjs
    if ($LASTEXITCODE -ne 0) { throw "Package preparation failed ($LASTEXITCODE)" }
} finally { Pop-Location }
