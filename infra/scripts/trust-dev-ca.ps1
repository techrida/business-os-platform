<#
.SYNOPSIS
  Trusts Caddy's local root CA for the current Windows user (no admin rights needed).
.DESCRIPTION
  Imports .dev/caddy-root.crt into the current user's "Trusted Root Certification Authorities" store, so Edge
  and Chrome open https://auth.localhost without a warning. Firefox keeps its own store and ignores this.
  Windows shows a confirmation dialog for the import: click Yes.
  By default the certificate is read from the WSL clone (~/src/business-os-platform/.dev/caddy-root.crt of the
  distro Ubuntu), so run infra/scripts/export-dev-ca.sh in WSL first.
.PARAMETER CertPath
  Use this file instead of reading it from WSL.
.PARAMETER Distro
  WSL distro that holds the clone. Default: Ubuntu.
.PARAMETER Remove
  Remove the certificate again.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\scripts\trust-dev-ca.ps1
#>
[CmdletBinding()]
param(
  [string]$CertPath,
  [string]$Distro = 'Ubuntu',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$tempFile = $null
if (-not $CertPath) {
  # Read the PEM text through WSL and write a clean ASCII copy (PowerShell 5.1 redirection would add a BOM).
  $lines = & wsl.exe -d $Distro -e bash -c 'cat ~/src/business-os-platform/.dev/caddy-root.crt'
  if ($LASTEXITCODE -ne 0 -or -not $lines) {
    throw "Could not read .dev/caddy-root.crt from WSL distro '$Distro'. Run 'bash infra/scripts/export-dev-ca.sh' there first, or pass -CertPath."
  }
  $tempFile = Join-Path ([IO.Path]::GetTempPath()) 'bos-caddy-root.crt'
  [IO.File]::WriteAllText($tempFile, (($lines -join "`n") + "`n"), [Text.Encoding]::ASCII)
  $CertPath = $tempFile
}
if (-not (Test-Path -LiteralPath $CertPath)) { throw "Certificate file not found: $CertPath" }

try {
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $CertPath
  # Safety check: only a self-signed certificate (a root CA) belongs in the Root store.
  if ($cert.Subject -ne $cert.Issuer) {
    throw "Refusing to trust $CertPath : it is not a self-signed root certificate (subject '$($cert.Subject)', issuer '$($cert.Issuer)')."
  }
  $thumb = $cert.Thumbprint
  $installed = Test-Path -LiteralPath "Cert:\CurrentUser\Root\$thumb"

  if ($Remove) {
    if ($installed) {
      & certutil.exe -user -delstore Root $thumb | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "certutil -delstore failed (exit $LASTEXITCODE)" }
      Write-Host "Removed $($cert.Subject) ($thumb) from the current user's Root store."
    } else {
      Write-Host "Not installed: $thumb"
    }
    return
  }

  if ($installed) {
    Write-Host "Already trusted: $($cert.Subject) ($thumb). Nothing to do."
    return
  }
  Write-Host "Importing $($cert.Subject) ($thumb). Windows will ask for confirmation: click Yes."
  & certutil.exe -user -addstore Root $CertPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "certutil -addstore failed (exit $LASTEXITCODE). Did you click No in the dialog?" }
  if (-not (Test-Path -LiteralPath "Cert:\CurrentUser\Root\$thumb")) { throw "Import reported success but the certificate is not in the store." }
  Write-Host "Trusted. Restart the browser, then open https://auth.localhost"
}
finally {
  if ($tempFile -and (Test-Path -LiteralPath $tempFile)) { Remove-Item -LiteralPath $tempFile -Force }
}
