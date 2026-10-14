param([int]$Port = 8010)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    throw 'Create the virtual environment and install requirements.txt first. See README.md.'
}
$taskTemp = Join-Path $PSScriptRoot '.runtime\tmp'
New-Item -ItemType Directory -Force -Path $taskTemp | Out-Null
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
& $taskPython -m uvicorn main:app --host 127.0.0.1 --port $Port
