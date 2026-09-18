param([Parameter(Mandatory=$true)][string]$AzumaDirectory,[Parameter(Mandatory=$true)][string]$MimoDirectory)
$ErrorActionPreference='Stop'
$config=@{azuma=[IO.Path]::GetFullPath($AzumaDirectory);mimo=[IO.Path]::GetFullPath($MimoDirectory)}
foreach($name in @('azuma','mimo')){if(-not(Test-Path -LiteralPath (Join-Path $config[$name] 'venv\Scripts\python.exe'))){throw "Missing Python runtime: $name"}}
$destination=Join-Path $env:LOCALAPPDATA 'AminOS\TTSLauncher'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.ps1') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $destination -Force
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'config.json') -Encoding UTF8
$key='HKCU:\Software\Classes\amin-tts'
if(Test-Path $key){$existing=(Get-ItemProperty "$key\shell\open\command" -ErrorAction SilentlyContinue).'(default)';if($existing -and -not $existing.Contains($destination)){throw 'Protocol already owned by a different application'}}
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-Item -Path $key -Value 'URL:Amin TTS Launcher'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command='"'+$powershell+'" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $destination 'launch.ps1')+'" "%1"'
Set-Item -Path "$key\shell\open\command" -Value $command
Write-Output 'Amin TTS launcher installed for current user.'
