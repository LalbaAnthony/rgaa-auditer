# --- Config ---
$PromptFile  = 'audit-prompt.md'
$LogFile     = 'audit.log'
$IntervalMin = 30

# --- No memory carried between runs ---
$env:CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'

# --- UTF-8 for piping to claude (PS 5.1 defaults to ASCII -> broken accents) ---
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

while ($true) {
    $start = Get-Date
    "`n=== $($start.ToString('yyyy-MM-dd HH:mm:ss')) ===" | Add-Content $LogFile -Encoding UTF8
    try {
        # Prompt re-read every run: edits to prompt.md apply without restart
        Get-Content $PromptFile -Raw -Encoding UTF8 |
            claude -p claude -p --permission-mode auto 2>&1 |
            Add-Content $LogFile -Encoding UTF8
    } catch {
        $_ | Out-String | Add-Content $LogFile -Encoding UTF8
    }
    # Fixed cadence: subtract run duration from the wait
    $elapsed = ((Get-Date) - $start).TotalSeconds
    Start-Sleep -Seconds ([math]::Max(0, $IntervalMin * 60 - $elapsed))
}