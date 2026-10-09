<#
.SYNOPSIS
    Audits the pages listed in audit-prompt.md one at a time, each in a fresh headless Claude Code run,
    until every page is in the shared report. See README.md.
.PARAMETER IntervalMinutes
    Minutes between the starts of two runs (fixed cadence: a long run shortens the next wait).
.PARAMETER MaxFailures
    Completed runs that did not merge their page before the page is skipped until the next launch.
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 1440)]
    [int]$IntervalMinutes = 30,
    [ValidateRange(1, 100)]
    [int]$MaxFailures = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# --- Config ---
$PromptFile   = 'audit-prompt.md'
$LogFile      = 'audit.log'
$McpConfig    = 'audit.mcp.json'
$ReportScript = 'scripts/audit-report.mjs'
$PageFile     = '.tmp/page.json'

# --- Each run gets the prompt only: no auto memory, no CLAUDE.md (project or user), no claude.ai connectors ---
$env:CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
$env:CLAUDE_CODE_DISABLE_CLAUDE_MDS  = '1'
$env:ENABLE_CLAUDEAI_MCP_SERVERS     = 'false'

# --- UTF-8 for piping to native programs (PS 5.1 defaults to ASCII -> broken accents) ---
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# --- Playwright MCP server only, explicit allow list, every other tool call denied ---
$ClaudeArgs = @(
    '-p'
    '--output-format', 'json'
    '--permission-mode', 'dontAsk'
    '--mcp-config', $McpConfig
    '--strict-mcp-config'
    '--tools', 'Read,Write,Bash'
    '--allowedTools', 'mcp__playwright', 'Edit(./.tmp/**)', "Bash(node $ReportScript merge *)"
    '--disallowedTools', 'mcp__playwright__browser_run_code_unsafe', 'mcp__playwright__browser_file_upload'
    '--no-session-persistence'
)

function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

# Runs a native program and returns its exit code, stdout and stderr separately.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$InputText
    )
    # PS 5.1 wraps each stderr line of a native program in an ErrorRecord: collect them instead of stopping
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($PSBoundParameters.ContainsKey('InputText')) {
            $output = $InputText | & $FilePath @Arguments 2>&1
        } else {
            $output = & $FilePath @Arguments 2>&1
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $stdout = @($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    $stderr = @($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.Exception.Message })
    [pscustomobject]@{ ExitCode = $exitCode; StdOut = ($stdout -join "`n"); StdErr = ($stderr -join "`n") }
}

# Report path and pages not in the report yet, in prompt order.
function Get-AuditState {
    $result = Invoke-Native -FilePath 'node' -Arguments @($ReportScript, 'remaining', '--prompt', $PromptFile)
    if ($result.ExitCode -ne 0) {
        throw "$ReportScript remaining failed (exit code $($result.ExitCode)):`n$($result.StdErr)"
    }
    $result.StdOut | ConvertFrom-Json
}

function Get-Field($Object, [string]$Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name } else { $null }
}

# Section appended to the prompt. "Parametres" takes a grave accent, built from its code point so that this
# file stays ASCII (PS 5.1 reads BOM-less scripts as ANSI).
function Get-RunParameters([string]$Url, [string]$Report) {
    $heading = 'Param' + [char]0x00E8 + 'tres du run'
    @(
        ''
        '---'
        ''
        "## $heading"
        ''
        'Valeurs fournies par audit-loop.ps1 pour ce run uniquement.'
        ''
        "- URL cible : $Url"
        "- Rapport : $Report"
        "- Fichier de page : $PageFile"
        "- Commande de fusion : ``node $ReportScript merge --report '$Report' --url '$Url' --page $PageFile``"
        ''
    ) -join "`n"
}

# Logs the JSON result of a claude -p run and classifies it:
#   'environment' - the agent stopped at step 0 (ENVIRONMENT_ERROR)
#   'cli'         - Claude Code itself failed (exit code, is_error, no JSON result): not the page's fault
#   'completed'   - the run ended normally
function Read-RunResult($Run) {
    if ($Run.StdErr) { Write-Log "claude stderr:`n$($Run.StdErr)" }
    $result = $null
    try {
        $result = $Run.StdOut | ConvertFrom-Json
    } catch {
        # Not JSON: Claude Code failed before producing a result; the raw output is logged below
        $result = $null
    }
    if ($null -eq (Get-Field $result 'type')) {
        Write-Log "claude exited with code $($Run.ExitCode) without a JSON result:`n$($Run.StdOut)"
        return 'cli'
    }
    $parts = @("exit code $($Run.ExitCode)", "subtype $(Get-Field $result 'subtype')", "$(Get-Field $result 'num_turns') turns")
    $duration = Get-Field $result 'duration_ms'
    if ($null -ne $duration) { $parts += '{0:N0} s' -f ($duration / 1000) }
    $cost = Get-Field $result 'total_cost_usd'
    if ($null -ne $cost) { $parts += 'cost {0:N2} USD' -f $cost }
    Write-Log ('Claude: ' + ($parts -join ', '))
    foreach ($denial in @(Get-Field $result 'permission_denials' | Where-Object { $null -ne $_ })) {
        $toolInput = Get-Field $denial 'tool_input'
        $detail = Get-Field $toolInput 'command'
        if ($null -eq $detail) { $detail = Get-Field $toolInput 'file_path' }
        if ($null -eq $detail) { $detail = $toolInput | ConvertTo-Json -Compress -Depth 5 }
        $detail = [string]$detail
        if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) + '...' }
        Write-Log "Permission denied: $(Get-Field $denial 'tool_name') $detail"
    }
    $text = [string](Get-Field $result 'result')
    if ($text) { Write-Log "Agent answer:`n$text" }
    if ($Run.ExitCode -ne 0 -or (Get-Field $result 'is_error') -eq $true) { return 'cli' }
    if ($text -match '(?m)^\s*ENVIRONMENT_ERROR') { return 'environment' }
    'completed'
}

$failures = @{}
$skipped = New-Object 'System.Collections.Generic.List[string]'

try {
    foreach ($command in 'node', 'claude') {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is not in PATH (see README.md)." }
    }
    foreach ($file in $PromptFile, $McpConfig, $ReportScript) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "$file not found (see README.md)." }
    }
    $state = Get-AuditState
    Write-Log ("=== Loop started: report {0}, {1} of {2} page(s) left, interval {3} min, {4} failed run(s) allowed per page ===" -f
        $state.report, @($state.remaining).Count, $state.total, $IntervalMinutes, $MaxFailures)

    while ($true) {
        $pending = @(@($state.remaining) | Where-Object { -not $skipped.Contains($_) })
        if ($pending.Count -eq 0) { break }
        $url = [string]$pending[0]
        $start = Get-Date
        Write-Log "--- Run: $url ($($pending.Count) page(s) left)"

        # A page file left by an earlier run must never be merged by mistake; the folder exists for the agent
        if (Test-Path -LiteralPath $PageFile) { Remove-Item -LiteralPath $PageFile -Force }
        [void](New-Item -ItemType Directory -Path (Split-Path -Parent $PageFile) -Force)
        $prompt = (Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8) + (Get-RunParameters -Url $url -Report $state.report)
        $outcome = Read-RunResult (Invoke-Native -FilePath 'claude' -Arguments $ClaudeArgs -InputText $prompt)

        $state = Get-AuditState
        if (@($state.remaining) -notcontains $url) {
            Write-Log "Merged: $url"
            $failures.Remove($url)
        } elseif ($outcome -eq 'environment') {
            throw 'the agent reported an environment error (see its answer above); fix it, then start the loop again'
        } elseif ($outcome -eq 'cli') {
            Write-Log 'Claude Code failed: not counted against the page, retried at the next run.'
        } else {
            $count = 1 + $(if ($failures.ContainsKey($url)) { $failures[$url] } else { 0 })
            $failures[$url] = $count
            if ($count -ge $MaxFailures) {
                $skipped.Add($url)
                Write-Log "Skipped until the next launch after $count failed run(s): $url"
            } else {
                Write-Log "Not merged ($count of $MaxFailures failed run(s) allowed): $url"
            }
        }

        $pending = @(@($state.remaining) | Where-Object { -not $skipped.Contains($_) })
        if ($pending.Count -eq 0) { break }
        $wait = [int][math]::Max(0, [math]::Ceiling($IntervalMinutes * 60 - ((Get-Date) - $start).TotalSeconds))
        Write-Log "Next run in $wait s"
        Start-Sleep -Seconds $wait
    }

    if ($skipped.Count) {
        Write-Log ("=== Loop finished: {0} page(s) skipped after failed runs, start the loop again to retry them: {1} ===" -f
            $skipped.Count, ($skipped -join ', '))
        exit 1
    }
    Write-Log "=== Loop finished: every page is in $($state.report) ==="
} catch {
    Write-Log "=== Loop stopped: $($_.Exception.Message) ==="
    exit 1
}
