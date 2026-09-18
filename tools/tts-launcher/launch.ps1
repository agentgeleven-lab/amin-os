param([Parameter(Mandatory=$true)][ValidateSet('amin-tts://start/azuma','amin-tts://start/mimo')][string]$Uri)
$ErrorActionPreference='Stop'
if($args.Count -ne 0){throw 'Unexpected arguments'}
$engine=($Uri -split '/')[-1]
$mutex=New-Object Threading.Mutex($false,('Local\AminTTS-'+$engine))
$owned=$false
try {
 try{$owned=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owned=$true}
 if(-not $owned){exit}
 $config=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
 $base=[IO.Path]::GetFullPath([string]$config.$engine)
 $port=if($engine -eq 'mimo'){9884}else{9883}
 $app=if($engine -eq 'mimo'){'mimo-rvc-studio'}else{'azuma-bert-vits2'}
 $script=if($engine -eq 'mimo'){'app.py'}else{'local_demo.py'}
 $health=$null
 try{$health=Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2}catch{}
 if($health){if($health.app -ne $app){throw 'Port occupied by another service'};exit}
 $python=Join-Path $base 'venv\Scripts\python.exe'
 $entry=Join-Path $base $script
 if(-not(Test-Path -LiteralPath $python)-or -not(Test-Path -LiteralPath $entry)){throw 'Model runtime not found. Reinstall launcher with the correct model folders.'}
 $env:PYTHONUTF8='1'
 $process=Start-Process -FilePath $python -ArgumentList @('-u',('"'+$entry+'"')) -WorkingDirectory $base -WindowStyle Hidden -RedirectStandardOutput (Join-Path $base 'server.log') -RedirectStandardError (Join-Path $base 'server-error.log') -PassThru
 for($i=0;$i -lt 90;$i++){
  Start-Sleep -Seconds 1
  try{$health=Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 1}catch{$health=$null}
  if($health){if($health.app -ne $app){throw 'Unexpected service on port'};exit}
  if($process.HasExited){throw 'Service exited. Check server-error.log in the model folder.'}
 }
 throw 'Service startup timed out. Check server-error.log in the model folder.'
}catch {
 $_.Exception.Message | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'last-error.txt') -Encoding UTF8
 Add-Type -AssemblyName PresentationFramework
 [System.Windows.MessageBox]::Show($_.Exception.Message,'Amin TTS launcher') | Out-Null
 exit 1
}finally{if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}
