# 隐藏控制台启动 EasyAG（管理员非必须）
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$env:NODE_NO_WARNINGS = '1'
$exe = Join-Path $dir 'EasyAntigravity.exe'
if (Test-Path $exe) {
  Start-Process -FilePath $exe -ArgumentList '--no-warnings' -WorkingDirectory $dir -WindowStyle Hidden
} else {
  Start-Process -FilePath 'node' -ArgumentList '--no-warnings','server.js' -WorkingDirectory $dir -WindowStyle Hidden
}
