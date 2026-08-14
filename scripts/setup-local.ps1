param(
  [switch]$FromClipboard
)

$ErrorActionPreference = 'Stop'

function New-PrimeHaxSecret {
  $bytes = New-Object byte[] 48
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

Write-Host 'Configuracion local de Prime Hax Social' -ForegroundColor Cyan
Write-Host 'La conexion se guardara solo en server\.env, ignorado por Git.'

if ($FromClipboard) {
  Write-Host ''
  Write-Host 'Ahora copia UNICAMENTE la URL completa de Session pooler.' -ForegroundColor Cyan
  Write-Host 'Debe comenzar exactamente con postgresql:// (sin un numero 1).'
  [void](Read-Host 'Cuando ya este copiada, vuelve aqui y presiona Enter')
  $databaseUrl = (Get-Clipboard -Raw).Trim().Trim('"').Trim("'")
  if (-not $databaseUrl) {
    throw 'El portapapeles esta vacio.'
  }
  Write-Host 'URL leida directamente desde el portapapeles.'
} else {
  $secureDatabaseUrl = Read-Host 'Pega la Session pooler URL de Supabase' -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureDatabaseUrl)
  try {
    $databaseUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

if ($databaseUrl -notmatch '^postgres(ql)?://') {
  throw 'La conexion debe comenzar con postgres:// o postgresql://'
}
if ($databaseUrl -match '\[YOUR-PASSWORD\]') {
  throw 'Todavia debes reemplazar [YOUR-PASSWORD] por la contrasena codificada.'
}

$escapedDatabaseUrl = $databaseUrl.Replace('"', '\"')
$environmentFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$contents = @(
  'NODE_ENV=development',
  'HOST=127.0.0.1',
  'PORT=3000',
  ('DATABASE_URL="{0}"' -f $escapedDatabaseUrl),
  'DATABASE_SSL=verify-full',
  'DATABASE_CA_CERT_PATH=./certs/supabase-ca.crt',
  ('JWT_ACCESS_SECRET={0}' -f (New-PrimeHaxSecret)),
  ('REFRESH_TOKEN_PEPPER={0}' -f (New-PrimeHaxSecret)),
  ('INVITE_CODE_PEPPER={0}' -f (New-PrimeHaxSecret)),
  ('RECOVERY_CODE_PEPPER={0}' -f (New-PrimeHaxSecret)),
  'ACCESS_TOKEN_MINUTES=15',
  'REFRESH_TOKEN_DAYS=30'
)

[IO.File]::WriteAllLines($environmentFile, $contents, [Text.UTF8Encoding]::new($false))

if ($FromClipboard) {
  Set-Clipboard -Value 'Prime Hax: conexion guardada localmente; portapapeles limpiado.'
  Write-Host 'El portapapeles fue limpiado para no dejar expuesta la contrasena.' -ForegroundColor Yellow
}

Write-Host "Configuracion guardada en $environmentFile" -ForegroundColor Green
Write-Host 'No compartas ese archivo ni lo subas a GitHub.' -ForegroundColor Yellow
