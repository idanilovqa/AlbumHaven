param([switch]$Run)
$ErrorActionPreference = 'Stop'
if (-not $Run) { Write-Output 'Prepared only. Root must grant the exclusive test slot before -Run.'; return }
$taskRepository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $taskRepository
$taskNode = 'C:\Program Files\nodejs\node.exe'
$taskTests = @(
 'tests/js/album-card-metadata.test.js',
 'tests/js/artist-alias-parity-e2e.test.js',
 'tests/js/track-modal-actions.test.js',
 'tests/js/global-player-detail-waveform.test.js',
 'tests/js/global-player-artwork.test.js',
 'tests/js/search-toolbar-anchor-geometry.test.js',
 'tests/js/search-toolbar-query-state.test.js',
 'tests/js/settings-menu-theme-measurement.test.js',
 'tests/js/e2e-action-production-paths.test.js',
 'tests/js/check-e2e-production-parity.test.js',
 'tests/js/ci-fixture-data-contracts.test.js',
 'tests/js/phase7-account-admin-presentation.test.js',
 'tests/js/playwright-utility-problematic-files-config.test.js',
 'tests/js/runtime/bootstrap-utility-event-handlers.test.js',
 'tests/js/runtime/utility-list-builders.test.js',
 'tests/js/runtime/problem-exclusion-mutations.test.js',
 'tests/js/runtime/utility-problematic-focused-track-render.test.js',
 'tests/js/runtime/utility-problematic-review-contracts.test.js',
 'tests/js/runtime/tag-editor-and-optimistic-updates.test.js',
 'tests/js/runtime/tag-editor-autofill-styling.test.js',
 'tests/js/runtime/settings-saved-loop-presentation.test.js',
 'tests/js/runtime/loop-range-controls.test.js'
)
$taskLog = Join-Path $PSScriptRoot 'task9-sep12-pom-focused.log'
& $taskNode --test --test-concurrency=1 @taskTests *> $taskLog
$taskTestExit = $LASTEXITCODE
& $taskNode scripts/check-e2e-production-parity.cjs *> (Join-Path $PSScriptRoot 'task9-sep12-pom-parity.log')
$taskParityExit = $LASTEXITCODE
@{pid=$PID; testsExitCode=$taskTestExit; parityExitCode=$taskParityExit; finished=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'task9-sep12-pom-focused-result.json')
if ($taskTestExit -ne 0 -or $taskParityExit -ne 0) { exit 1 }
exit 0
