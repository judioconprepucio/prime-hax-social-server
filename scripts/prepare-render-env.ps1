param()

$ErrorActionPreference = 'Stop'
$serverRoot = Split-Path $PSScriptRoot -Parent
$sourcePath = Join-Path $serverRoot '.env'
$privateDirectory = Join-Path $serverRoot '.private'
$destinationPath = Join-Path $privateDirectory 'render.env'

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw '.env no existe. Ejecuta primero setup-local.ps1.'
}

$allowedSecretNames = @(
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'REFRESH_TOKEN_PEPPER',
  'INVITE_CODE_PEPPER',
  'RECOVERY_CODE_PEPPER'
)

$selectedLines = Get-Content -LiteralPath $sourcePath | Where-Object {
  $line = $_
  $allowedSecretNames | Where-Object { $line.StartsWith("$_=") }
}

if ($selectedLines.Count -ne $allowedSecretNames.Count) {
  throw 'Faltan secretos requeridos en .env.'
}

New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null
[IO.File]::WriteAllLines($destinationPath, $selectedLines, [Text.UTF8Encoding]::new($false))
Write-Host "Archivo privado preparado en $destinationPath" -ForegroundColor Green
Write-Host 'No lo subas a GitHub ni lo compartas.' -ForegroundColor Yellow
