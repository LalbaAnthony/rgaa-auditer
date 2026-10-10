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
# Working directory of the agents, emptied before each run. It is the workspace root of the Playwright MCP
# server: every file an agent names in a Playwright tool (screenshot, snapshot...) lands in it, and the server
# rejects any path outside it. The agents see the paths below relative to it.
$WorkDir           = '.tmp'
$PageFile          = 'page.json'
$AgentReportScript = "../$ReportScript"

# --- Each run gets the prompt only: no auto memory, no CLAUDE.md (project or user), no claude.ai connectors ---
$env:CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
$env:CLAUDE_CODE_DISABLE_CLAUDE_MDS  = '1'
$env:ENABLE_CLAUDEAI_MCP_SERVERS     = 'false'

# --- claude -p connects MCP servers in the background and starts the first turn after at most 2 s; a server
# connected later never gives its tools to the run. The server of audit.mcp.json has "alwaysLoad": true, so the
# first turn waits for it, up to this deadline (5 s by default, which a slow npx start exceeds) ---
$env:MCP_CONNECT_TIMEOUT_MS = '30000'

# --- UTF-8 for piping to native programs (PS 5.1 defaults to ASCII -> broken accents) ---
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# --- Playwright MCP server only, explicit allow list, every other tool call denied ---
$ClaudeArgs = @(
    '-p'
    '--output-format', 'json'
    '--permission-mode', 'dontAsk'
    '--mcp-config', (Join-Path $PSScriptRoot $McpConfig)
    '--strict-mcp-config'
    '--tools', 'Read,Write,Bash'
    '--allowedTools', 'mcp__playwright', "Edit(./$PageFile)", "Bash(node $AgentReportScript merge *)"
    '--disallowedTools', 'mcp__playwright__browser_run_code_unsafe', 'mcp__playwright__browser_file_upload'
    '--no-session-persistence'
)

# Runs a file operation again when it fails, for a file briefly locked by another process (editor, antivirus,
# indexer); rethrows the last error.
function Invoke-WithRetry([scriptblock]$Action) {
    $attempt = 0
    while ($true) {
        try {
            & $Action
            return
        } catch {
            $attempt++
            if ($attempt -ge 5) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
}

# A line that cannot be written to the log is still shown in the console: a locked log never stops the loop.
function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        Invoke-WithRetry { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 }
    } catch {
        Write-Warning "Line above not written to ${LogFile}: $($_.Exception.Message)"
    }
}

# Runs a native program in a directory and returns its exit code, stdout and stderr separately.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$InputText,
        [string]$WorkingDirectory = '.'
    )
    # A native program starts in the current location of PowerShell
    Push-Location -LiteralPath $WorkingDirectory
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
        Pop-Location
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

# Version of @playwright/mcp pinned in the MCP configuration, given to the agents: they cannot read the file
# from their working directory.
function Get-PlaywrightMcpVersion {
    $config = Get-Content -LiteralPath $McpConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $server = Get-Field (Get-Field $config 'mcpServers') 'playwright'
    foreach ($arg in @(Get-Field $server 'args')) {
        if ([string]$arg -match '^@playwright/mcp@(\d+\.\d+\.\d+)$') { return $Matches[1] }
    }
    throw "$McpConfig does not pin @playwright/mcp@<version> in mcpServers.playwright.args (see README.md)."
}

# Empties the working directory of the agents, so that no page file or Playwright output of an earlier run
# is merged or read.
function Reset-WorkDir {
    [void](New-Item -ItemType Directory -Path $WorkDir -Force)
    Invoke-WithRetry { Get-ChildItem -LiteralPath $WorkDir -Force | Remove-Item -Recurse -Force }
}

# Section appended to the prompt, with paths relative to the working directory of the agent. "Parametres" takes
# a grave accent, built from its code point so that this file stays ASCII (PS 5.1 reads BOM-less scripts as ANSI).
function Get-RunParameters([string]$Url, [string]$Report, [string]$McpVersion) {
    $heading = 'Param' + [char]0x00E8 + 'tres du run'
    $agentReport = "../$Report"
    @(
        ''
        '---'
        ''
        "## $heading"
        ''
        'Valeurs fournies par audit-loop.ps1 pour ce run uniquement.'
        ''
        "- URL cible : $Url"
        "- Rapport : $agentReport"
        "- Fichier de page : $PageFile"
        "- Version de @playwright/mcp : $McpVersion"
        "- Commande de fusion : ``node $AgentReportScript merge --report '$agentReport' --url '$Url' --page $PageFile``"
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
    $mcpVersion = Get-PlaywrightMcpVersion
    $state = Get-AuditState
    Write-Log ("=== Loop started: report {0}, {1} of {2} page(s) left, interval {3} min, {4} failed run(s) allowed per page, @playwright/mcp {5} ===" -f
        $state.report, @($state.remaining).Count, $state.total, $IntervalMinutes, $MaxFailures, $mcpVersion)

    while ($true) {
        $pending = @(@($state.remaining) | Where-Object { -not $skipped.Contains($_) })
        if ($pending.Count -eq 0) { break }
        $url = [string]$pending[0]
        $start = Get-Date
        Write-Log "--- Run: $url ($($pending.Count) page(s) left)"

        Reset-WorkDir
        $prompt = (Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8) + (Get-RunParameters -Url $url -Report $state.report -McpVersion $mcpVersion)
        $outcome = Read-RunResult (Invoke-Native -FilePath 'claude' -Arguments $ClaudeArgs -InputText $prompt -WorkingDirectory $WorkDir)

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
