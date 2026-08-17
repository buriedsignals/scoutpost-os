$ErrorActionPreference = 'Stop'

$workflowPath = Join-Path $PSScriptRoot '../../.github/workflows/cli-release.yml'
$workflow = (Get-Content -Raw -LiteralPath $workflowPath).Replace("`r`n", "`n").Replace("`r", "`n")
$stepMarker = "      - name: Native signed-binary and npm install/update/uninstall lifecycle`n"
$attestationMarker = "      - name: Attest signed Windows release provenance`n"
$runMarker = "        run: |`n"

$stepStart = $workflow.IndexOf($stepMarker, [System.StringComparison]::Ordinal)
$stepEnd = $workflow.IndexOf($attestationMarker, $stepStart, [System.StringComparison]::Ordinal)
if ($stepStart -lt 0 -or $stepEnd -le $stepStart) {
  throw 'Windows release lifecycle step could not be isolated'
}

$step = $workflow.Substring($stepStart, $stepEnd - $stepStart)
$runStart = $step.IndexOf($runMarker, [System.StringComparison]::Ordinal)
if ($runStart -lt 0) { throw 'Windows release lifecycle run block is missing' }
$runStart += $runMarker.Length

$sourceLines = $step.Substring($runStart).Split("`n")
$dedented = @(
  foreach ($line in $sourceLines) {
    if ($line.Length -eq 0) {
      ''
      continue
    }
    if (-not $line.StartsWith('          ', [System.StringComparison]::Ordinal)) {
      throw 'Windows release lifecycle contains an invalid indentation level'
    }
    $line.Substring(10)
  }
)
$source = [string]::Join("`n", $dedented)
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseInput(
  $source,
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -ne 0) {
  $messages = ($errors | ForEach-Object { $_.Message }) -join '; '
  throw "Windows release lifecycle has PowerShell syntax errors: $messages"
}

Write-Output 'Windows release lifecycle PowerShell syntax is valid'
