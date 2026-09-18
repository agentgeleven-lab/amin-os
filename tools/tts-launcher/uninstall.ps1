$ErrorActionPreference='Stop'
$key='HKCU:\Software\Classes\amin-tts'
$destination=Join-Path $env:LOCALAPPDATA 'AminOS\TTSLauncher'
if(Test-Path $key){$command=(Get-ItemProperty "$key\shell\open\command").'(default)';if(-not $command.Contains($destination)){throw 'Protocol owned by another application'};Remove-Item -LiteralPath $key -Recurse}
Write-Output 'Launcher registration removed. Model files and services were not changed.'
