# CLAUDE.md

Guidance for Claude Code sessions that maintain this repository. The audit agents started by `audit-loop.ps1` never read this file: the loop sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, so they only receive `audit-prompt.md` and the run parameters.

## Project

RGAA 4.1.2 audits of a page list. `audit-loop.ps1` starts one headless `claude -p` agent per page; each agent audits its page through the Playwright MCP server and merges it into one shared JSON report with `scripts/audit-report.mjs`; `viewer/index.html` displays the report. Read `README.md` for the workflow, `docs/audit-format.md` for the report contract, `docs/viewer.md` for the viewer.

## Design decisions

Keep these unless the user decides otherwise:

- One shared report per audit, `audits/<name>_YYYY-MM-DD.json`. Its path is set by a human in the `audit-report` block of the prompt; the final date becomes `date`.
- Agents are isolated on purpose: a fresh context per page, no knowledge of the other runs, the report as the only shared state. Runs are sequential (one loop per report, no locking).
- Agents never write the report. They write `.tmp/page.json` and run `merge`; only `scripts/report.mjs` writes reports, atomically.
- The loop owns page selection (`remaining`) and retries: `ENVIRONMENT_ERROR` in the agent's answer stops the loop; Claude Code failures are not counted against the page; a completed run without merge counts, and a page is skipped until the next launch after `-MaxFailures` of them.
- A page is audited once per report; `merge` rejects a URL already present. A page that cannot be audited is merged with `error` and no criteria.
- Every criterion has one fixed method (`docs/rgaa-criteria.json`), which bounds its statuses; `manual_required` allows only `to_verify` and `not_applicable`. `merge` injects `topic`, `title` and `method`, so they are identical on every page.
- The report contract is strict (`scripts/report.mjs`, `docs/audit.schema.json`); the viewer stays tolerant of looser files.
- `environment` is written once, from the first merged page. The model is not pinned.
- The viewer is one HTML file without build step; Alpine.js and Tailwind are pinned on jsDelivr.

## Keep in sync

| When you change                         | Also update                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| The criteria (topic, title, method)     | `docs/rgaa-criteria.json`, the grid of `audit-prompt.example.md`, the enumerations of `docs/audit.schema.json`                       |
| The report or page submission format    | `scripts/report.mjs` and its tests, `docs/audit.schema.json`, `docs/audit-format.md`, step 4 of `audit-prompt.example.md`, `parseAudit` in `viewer/index.html` and `viewer/viewer.test.mjs`, `docs/viewer.md` |
| The loop, its flags or the agent tools  | `audit-loop.ps1`, the run sections of `README.md`, steps 0 and 4 of `audit-prompt.example.md` (run parameters, `ENVIRONMENT_ERROR`, merge command) |
| The pinned `@playwright/mcp` version    | `audit.mcp.json` and the install command in `README.md`; the browser must be installed again                                         |
| The viewer                              | `viewer/index.html`, `viewer/viewer.test.mjs`, `docs/viewer.md`                                                                      |

`npm test` fails when the prompt grid or the schema enumerations drift from `docs/rgaa-criteria.json`, and checks the MCP flags, the script and the viewer's reading of merged reports.

## Rules

- Never modify, move or delete files in `audits/`: they are real audit data. Tests work in temporary directories.
- Do not run `audit-loop.ps1`, or `claude -p` with the audit prompt, unless asked: it starts real audits on the user's account.
- `audit-loop.ps1` must run on Windows PowerShell 5.1: keep the file ASCII (5.1 reads BOM-less scripts as ANSI) and avoid PowerShell 7 syntax (`??`, `?.`, ternary, `&&`, `||`).
- The agents run with `--permission-mode dontAsk` and an allow list: a tool the prompt starts to need must be added to `$ClaudeArgs` in `audit-loop.ps1`, or every call to it is denied (the denials are logged in `audit.log`). File writes are allowed with `Edit(<path>)` rules: a `Write(<path>)` rule matches nothing.
- Agents read the error messages of `merge` to fix their page: keep them specific and actionable.
- Node.js 20 or later, ES modules (`.mjs`), no dependencies; tests use `node:test`.
- Documentation states only what the code does: check a behaviour (in a browser for the viewer) before documenting it.
- Markdown: one line per paragraph or list item, no hard wraps.

## Commands

```sh
npm test
node scripts/audit-report.mjs remaining --prompt audit-prompt.md
node scripts/audit-report.mjs validate --report audits/<name>_YYYY-MM-DD.json
npx ajv-cli@5 validate --spec=draft2020 -s docs/audit.schema.json -d audits/<name>_YYYY-MM-DD.json
```
