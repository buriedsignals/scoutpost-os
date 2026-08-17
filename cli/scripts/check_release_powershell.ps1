$ErrorActionPreference = 'Stop'

$workflowPath = Join-Path $PSScriptRoot '../../.github/workflows/cli-release.yml'
$workflow = (Get-Content -Raw -LiteralPath $workflowPath).Replace("`r`n", "`n").Replace("`r", "`n")

function Assert-EmbeddedPowerShell {
  param(
    [Parameter(Mandatory=$true)][string]$StepMarker,
    [Parameter(Mandatory=$true)][string]$EndMarker,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $runMarker = "        run: |`n"
  $stepStart = $workflow.IndexOf($StepMarker, [System.StringComparison]::Ordinal)
  $stepEnd = $workflow.IndexOf($EndMarker, $stepStart, [System.StringComparison]::Ordinal)
  if ($stepStart -lt 0 -or $stepEnd -le $stepStart) {
    throw "$Label step could not be isolated"
  }

  $step = $workflow.Substring($stepStart, $stepEnd - $stepStart)
  $runStart = $step.IndexOf($runMarker, [System.StringComparison]::Ordinal)
  if ($runStart -lt 0) { throw "$Label run block is missing" }
  $runStart += $runMarker.Length

  $sourceLines = $step.Substring($runStart).Split("`n")
  $dedented = @(
    foreach ($line in $sourceLines) {
      if ($line.Length -eq 0) {
        ''
        continue
      }
      if (-not $line.StartsWith('          ', [System.StringComparison]::Ordinal)) {
        throw "$Label contains an invalid indentation level"
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
    throw "$Label has PowerShell syntax errors: $messages"
  }
}

Assert-EmbeddedPowerShell `
  -StepMarker "      - name: Native signed-binary and npm install/update/uninstall lifecycle`n" `
  -EndMarker "      - name: Install local provenance signer`n" `
  -Label 'Windows release lifecycle'
Assert-EmbeddedPowerShell `
  -StepMarker "      - name: Verify local signed Windows release provenance`n" `
  -EndMarker "      - uses: actions/upload-artifact@" `
  -Label 'Windows local provenance verification'

Write-Output 'Windows release lifecycle and local provenance PowerShell syntax are valid'
