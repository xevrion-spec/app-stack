param([Parameter(Mandatory)][ValidateSet('dify','langfuse','postiz','temporal','steel','daytona','coolify','bridge','freellmapi')][string]$App,
      [Parameter(Mandatory)][ValidateSet('up','stop')][string]$Action)
$root = Join-Path $PSScriptRoot 'services'
if ($App -eq 'freellmapi') {
  if ($Action -eq 'up') { Start-Process -WindowStyle Minimized -WorkingDirectory "$env:USERPROFILE\freellmapi" npm.cmd 'run','dev','-w','server' }
  else { Get-NetTCPConnection -LocalPort 3010 -State Listen -EA SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force } }
  exit
}
if ($App -eq 'bridge') {
  $py = Join-Path $PSScriptRoot 'bridge\.venv\Scripts\python.exe'
  if ($Action -eq 'up') {
    if (-not (Test-Path $py)) { uv venv --python 3.12 (Join-Path $PSScriptRoot 'bridge\.venv'); uv pip install --python $py -q -r (Join-Path $PSScriptRoot 'bridge\requirements.txt') }
    Start-Process -WindowStyle Minimized -WorkingDirectory (Join-Path $PSScriptRoot 'bridge') $py '-m','uvicorn','app:app','--host','0.0.0.0','--port','8765'
    Write-Host 'bridge on http://localhost:8765 (Dify: http://host.docker.internal:8765)'
  } else { Get-NetTCPConnection -LocalPort 8765 -State Listen -EA SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force } }
  exit
}
switch ($App) {
  'dify'     { $dir="$root\dify\docker"; $f=@() }
  'langfuse' { $dir="$root\langfuse"; $f=@() }
  'postiz'   { $dir="$root\postiz"; $f=@(); $svc=@('postiz','postiz-postgres','postiz-redis') }
  'temporal' { $dir="$root\postiz"; $f=@(); $svc=@('temporal-postgresql','temporal-elasticsearch','temporal','temporal-admin-tools','temporal-ui') }
  'steel'    { $dir="$root\steel"; $f=@() }
  'daytona'  { $dir="$root\daytona\docker"; $f=@('-f','docker-compose.yaml','-f','docker-compose.override.yaml') }
  'coolify'  { Write-Host 'Coolify runs in the cloud: https://app.coolify.io'; exit 0 }
}
Push-Location $dir
try {
  if ($svc) {
    $names = docker ps -a --format '{{.Names}}'
    $targets = $svc | Where-Object { $names -contains $_ }
    if ($Action -eq 'up') { docker start @targets } else { docker stop @targets }
  } else {
    if ($Action -eq 'up') { docker compose @f up -d } else { docker compose @f stop }
  }
} finally { Pop-Location }
