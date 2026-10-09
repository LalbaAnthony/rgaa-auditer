# Audit report format

Each audit produces one shared JSON report. The audit agents never write it directly: each agent submits its page to `node scripts/audit-report.mjs merge`, which validates the page and appends it to the report. This document is the contract of that report and of the page submissions. [`audit.schema.json`](audit.schema.json) expresses the report contract as a JSON Schema (draft 2020-12), and [`rgaa-criteria.json`](rgaa-criteria.json) lists the canonical criteria.

The viewer accepts a looser input, described in [viewer.md](viewer.md#input-format).

## File

- **Location and name**: `audits/<name>_YYYY-MM-DD.json`, set in the `audit-report` block of `audit-prompt.md`. `<name>` is free (a site name, for example), so that several audits can share a date. The final date is the audit date and becomes the `date` field. Report files are ignored by git.
- **Lifecycle**: the first merge creates the report; each later merge appends one page. A page URL appears at most once: to audit a page again, start a new report. Pages are never modified, reordered or removed.
- **Writes**: one audit loop at a time per report (pages are merged sequentially). The merge writes a temporary file next to the report, then renames it over the report. It refuses to append to a report that fails validation, so a report edited by hand blocks the audit until it is fixed.
- **Encoding**: UTF-8, two-space indentation, final newline.

## Structure

```json
{
  "date": "2026-01-15",
  "reference_framework": "RGAA 4.1.2",
  "environment": {
    "playwright_mcp": "0.0.83",
    "chromium": "155.0.8059.12"
  },
  "pages": [
    {
      "url": "https://www.example.com/",
      "final_url": "https://www.example.com/home",
      "audited_at": "2026-01-15T09:30:00Z",
      "http_status": 200,
      "criteria": [
        {
          "number": "1.1",
          "topic": "Images",
          "title": "Informative images have a text alternative",
          "status": "non_compliant",
          "method": "automated",
          "affected_elements": ["header a.logo > img"],
          "finding": "The logo image inside the home link has no alt attribute.",
          "faulty_code": "<a class=\"logo\" href=\"/\"><img src=\"/logo.svg\"></a>",
          "expected_correction": "Give the logo image an alt attribute naming the destination, e.g. alt=\"Example, home page\"."
        },
        { "number": "1.2", "topic": "Images", "title": "Decorative images are ignored by assistive technologies", "status": "compliant", "method": "automated" }
      ]
    },
    {
      "url": "https://www.example.com/old-page",
      "audited_at": "2026-01-15T10:00:00Z",
      "http_status": 404,
      "error": "HTTP 404 Not Found",
      "criteria": []
    }
  ]
}
```

The first page above is abbreviated: an audited page lists all 106 criteria.

### Report

| Field                 | Type   | Content                                                                                                               |
| --------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `date`                | string | Audit date (`YYYY-MM-DD`), taken from the end of the file name when the report is created                             |
| `reference_framework` | string | `RGAA 4.1.2`, the `reference_framework` of `rgaa-criteria.json`                                                       |
| `environment`         | object | Environment of the first merged page, never modified afterwards: `playwright_mcp` and `chromium`                     |
| `pages`               | array  | At least one page, in merge order                                                                                     |

`environment.playwright_mcp` is the version of `@playwright/mcp` pinned in `audit.mcp.json` (`unknown` if the agent could not read it). `environment.chromium` is the full browser version, read with `navigator.userAgentData.getHighEntropyValues(['fullVersionList'])` on the audited page; that API only exists in secure contexts (HTTPS or localhost), and `navigator.userAgent` only carries the major version (`155.0.0.0`), which is what an HTTP page gives. No other property is allowed.

### Page

| Field         | Type    | Content                                                                                                   |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `url`         | string  | Page URL, exactly as written in the page list of the prompt; unique in the report                         |
| `final_url`   | string  | Optional: the URL actually displayed after redirects, only when it differs from `url`                     |
| `audited_at`  | string  | UTC time of the merge, ISO 8601 without fractional seconds (`2026-01-15T09:30:00Z`)                       |
| `http_status` | integer | HTTP status of the main document after redirects; required unless `error` is set                          |
| `error`       | string  | Only for a page that could not be audited: the reason (HTTP error, timeout, network error)                 |
| `criteria`    | array   | The 106 criteria, in the order of `rgaa-criteria.json`; empty when `error` is set                          |

### Criterion

| Field                 | Type   | Content                                                                                                     |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `number`              | string | Criterion number, a string (`"3.10"` is not `"3.1"`)                                                        |
| `topic`               | string | Canonical topic, from `rgaa-criteria.json`                                                                  |
| `title`               | string | Canonical short title, from `rgaa-criteria.json`                                                            |
| `status`              | string | `non_compliant`, `to_verify`, `compliant` or `not_applicable`                                               |
| `method`              | string | Canonical method, from `rgaa-criteria.json`: `automated`, `agent_judgment` or `manual_required`             |
| `affected_elements`   | array  | CSS selectors of the elements concerned (at least one)                                                      |
| `finding`             | string | What was observed, or what a human must check                                                               |
| `faulty_code`         | string | A representative code fragment captured on the page, on one line, 500 characters at most; `…` marks cuts   |
| `expected_correction` | string | Concrete action that resolves the defect                                                                    |

Free-text fields are written in English. Strings are never empty.

## Methods and statuses

Each criterion has one fixed method, set in `rgaa-criteria.json`:

| Method            | Meaning                                                                                                   | Allowed statuses                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `automated`       | A script fully checks the criterion: firm verdict                                                         | all; `to_verify` only when the check could not run, explained in `finding`       |
| `agent_judgment`  | The agent judges from the snapshot, screenshot or interaction, supported by scripted checks when possible | all; a defect found is `non_compliant`, a real doubt or a partial check `to_verify` |
| `manual_required` | Out of reach of a machine (listening to media, real screen reader output, consistency across pages, downloaded documents) | `to_verify`, or `not_applicable` when the subject of the criterion is absent |

A criterion whose subject is absent from the page (no media, no table, no frame, no form field…) is `not_applicable`.

## Fields by status

| Status           | `finding`                                                    | `affected_elements`, `faulty_code`                      | `expected_correction` |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------- | --------------------- |
| `non_compliant`  | required: the defect                                         | required when an element of the page is concerned       | required              |
| `to_verify`      | required: what a human must check, and why the agent could not conclude | optional                                     | optional              |
| `compliant`      | optional: short justification                                | not allowed                                             | not allowed           |
| `not_applicable` | optional: short justification                                | not allowed                                             | not allowed           |

A defect of absence (no `main`, no `title`, no skip link) concerns no element: it is described in `finding` only. Several faulty elements for one criterion make one entry, with every element in `affected_elements`.

## Pages that could not be audited

A page that returns an HTTP error, times out or fails to load is merged with `error` and an empty `criteria` array, plus `http_status` when a response was received. It counts as merged: the loop does not retry it in the same report. The viewer lists such pages separately.

## Page submission

An agent writes its page to `.tmp/page.json`, then runs the merge command given by the loop:

```sh
node scripts/audit-report.mjs merge --report 'audits/<name>_YYYY-MM-DD.json' --url '<page URL>' --page .tmp/page.json
```

The page file holds the environment and the page, without `audited_at` and without the canonical fields:

```json
{
  "environment": { "playwright_mcp": "0.0.83", "chromium": "155.0.8059.12" },
  "page": {
    "url": "https://www.example.com/",
    "http_status": 200,
    "criteria": [
      { "number": "1.1", "status": "non_compliant", "affected_elements": ["header a.logo > img"], "finding": "…", "faulty_code": "…", "expected_correction": "…" },
      { "number": "1.2", "status": "compliant" }
    ]
  }
}
```

- `environment` is required on every submission; only the one of the first merged page is recorded.
- `page.url` must be exactly the `--url` value. `page` accepts `url`, `final_url`, `http_status`, `error` and `criteria`.
- `criteria` lists the 106 criteria once each, in any order, with `number`, `status` and the detail fields allowed by the status. `topic`, `title` and `method` are rejected: the merge adds them from `rgaa-criteria.json` and sorts the criteria in canonical order.
- The merge adds `audited_at` (the current UTC time).
- An invalid submission is rejected as a whole, with the list of problems; nothing is written. The agent fixes the file and runs the command again.

## Commands

[`scripts/audit-report.mjs`](../scripts/audit-report.mjs) needs Node.js 20 or later and no dependency. Exit codes: 0 success, 1 invalid input or report, 2 usage error.

| Command                                                                             | Purpose                                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `node scripts/audit-report.mjs remaining --prompt audit-prompt.md`                  | Prints the report path, the number of pages in the prompt and the pages not in the report yet, as JSON (used by the loop) |
| `node scripts/audit-report.mjs merge --report <file> --url <url> --page <file>`     | Validates one page submission and appends it (used by the agents)                                                    |
| `node scripts/audit-report.mjs validate --report <file>`                            | Validates a whole report                                                                                             |

`merge` and `validate` check every rule of this document that a program can check (not, for example, whether an element is concerned by a defect, or the language of the texts). The JSON Schema covers the same rules except those it cannot express: each criterion listed once in canonical order with its canonical topic, title and method, unique page URLs, and a `date` matching the file name. To check a report with a generic validator:

```sh
npx ajv-cli@5 validate --spec=draft2020 -s docs/audit.schema.json -d audits/<name>_YYYY-MM-DD.json
```

## Canonical criteria

[`rgaa-criteria.json`](rgaa-criteria.json) gives the `reference_framework` and, for each of the 106 criteria in RGAA order, its `number`, `topic`, short English `title` and `method`. The merge copies `topic`, `title` and `method` into the report, so every page of every report uses the same values. The audit grid of `audit-prompt.example.md` and the enumerations of `audit.schema.json` repeat this list; `npm test` fails when they drift apart.
