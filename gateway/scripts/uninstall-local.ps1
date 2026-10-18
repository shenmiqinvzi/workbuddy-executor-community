[CmdletBinding(SupportsShouldProcess=$true)]
param()
$ErrorActionPreference = 'Stop'
$gatewayRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $gatewayRoot 'data\local-installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $gatewayRoot.Equals($manifest.gateway_root,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Installation root does not match manifest.' }
$expectedSkill = [System.IO.Path]::GetFullPath($manifest.skill_root)
$namedSkill = [System.IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\skills\workbuddy-executor'))
if (-not $expectedSkill.Equals($namedSkill,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Skill target is outside the named installation directory.' }
if (-not $PSCmdlet.ShouldProcess($gatewayRoot,'Remove this gateway MCP, supervisor and its unchanged Skill; preserve task history and WorkBuddy data')) { return }
$stateFile = Join-Path $gatewayRoot 'data\persistent-service-status.json'
if (Test-Path -LiteralPath $stateFile) {
  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
  if ($process -and ($process.ExecutablePath -ne $manifest.node_bin -or -not $process.CommandLine.Contains((Join-Path $gatewayRoot 'dist\service-cli.js')))) { throw 'Stored PID belongs to another process; supervisor was not stopped.' }
}
& $manifest.node_bin (Join-Path $gatewayRoot 'dist\service-cli.js') uninstall
if ($LASTEXITCODE -ne 0) { throw 'Supervisor uninstall failed.' }
$codexBin = $manifest.codex_bin
if (-not $codexBin -or -not (Test-Path -LiteralPath $codexBin)) { $codexBin = (Get-Command codex -ErrorAction Stop).Source }
& $codexBin mcp remove workbuddy
if ($LASTEXITCODE -ne 0) { throw 'MCP removal failed.' }
if (Test-Path -LiteralPath $expectedSkill) {
  $item = Get-Item -LiteralPath $expectedSkill
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refuse recursive removal of a linked Skill directory.' }
  $actualFiles = @(Get-ChildItem -LiteralPath $expectedSkill -Recurse -File)
  $properties = @($manifest.installed_skill_files.PSObject.Properties)
  $unchanged = $actualFiles.Count -eq $properties.Count
  foreach ($property in $properties) {
    $file = [System.IO.Path]::GetFullPath((Join-Path $expectedSkill $property.Name))
    if (-not $file.StartsWith($expectedSkill + '\',[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Skill file escapes the named target.' }
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) { $unchanged = $false }
  }
  if ($unchanged) { Remove-Item -LiteralPath $expectedSkill -Recurse -Force } else { Write-Output 'Skill has local changes; it was preserved for manual review.' }
}
Write-Output 'Gateway connection and startup removed. Gateway files, task records, backups, WorkBuddy account and native sessions preserved.'
