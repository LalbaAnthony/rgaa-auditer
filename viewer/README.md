# RGAA Audit Viewer

A single-file, browser-based viewer for RGAA accessibility audit results stored as JSON. You can browse findings by criterion or by page, filter them, track which entries are fixed, and copy ready-to-use prompts for a coding agent.

[RGAA](https://accessibilite.numerique.gouv.fr/) (Référentiel général d'amélioration de l'accessibilité) is the French accessibility reference framework. It has 106 criteria in 13 topics and is based on WCAG.

## Features

- **Two views**: *By criterion* (each criterion lists its results page by page) and *By page* (each page lists its criteria). Groups can be collapsed. Each entry is a single line with a status badge and an excerpt of the finding, and expands to show the full details.
- **Filters**: status, done state, topic, detection method, scope (the number of pages where a criterion fails) and pages, plus a full-text search. The count next to each filter value updates as the other filters change.
- **Fix tracking**: mark non-compliant and to-verify entries as done, one at a time or for a whole criterion on all pages in one click, with undo. A progress meter shows how much is done.
- **Agent prompts**: copy a Markdown prompt to fix a single entry, or every open entry of a criterion. The prompt includes the audit data, your project context and step-by-step instructions.
- **Readable details**: faulty code is shown one tag per line with syntax colouring. Copy buttons are provided for selectors, faulty code and the expected correction, and links lead to the audited page and the official criterion.
- **Comfort**: keyboard shortcuts, light and dark themes, and a layout that works from desktop down to mobile widths.
- **Local only**: the audit is read in the browser and nothing is uploaded. The last audit and your progress are kept in `localStorage`.

## Quick start

1. Download `index.html`.
2. Open it in a Chromium-based browser. Double-clicking the file (`file://`) works; no server is needed.
3. Drop an audit JSON file on the page, or click **choose a file**.

The next time you open the page, the last loaded audit is restored automatically. To switch, use **Load another audit** or drop another file anywhere on the page.

An Internet connection is needed when the page loads, because the two libraries come from a CDN (see [Requirements](#requirements)).

## Requirements

- **Browser**: tested in Chromium-based browsers (Chrome, Edge, Brave and others). Firefox and Safari have not been tested.
- **Browser features used**: `localStorage`, `CompressionStream` / `DecompressionStream` (gzip), the Clipboard API (with an `execCommand('copy')` fallback), `<dialog>`, CSS `:has()` and `content-visibility`.
- **Libraries**: both are loaded from jsDelivr with pinned versions:
  - [Alpine.js](https://alpinejs.dev/) 3.17.4: `https://cdn.jsdelivr.net/npm/alpinejs@3.17.4/dist/cdn.min.js`
  - [Tailwind CSS](https://tailwindcss.com/) 4.3.3, browser build: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js`

  If the libraries cannot be loaded (for example when offline), the page shows an explanatory message after 5 seconds.

## Input format

The viewer reads one JSON object per audit. Its structure is formally described in [`audit.schema.json`](audit.schema.json) (JSON Schema 2020-12). A minimal example:

```json
{
  "date": "2026-01-15",
  "reference_framework": "RGAA 4.1",
  "environment": { "browser": "Chromium 140" },
  "pages": [
    {
      "url": "https://www.example.com/",
      "audited_at": "2026-01-15T09:30:00Z",
      "criteria": [
        {
          "number": "1.1",
          "topic": "Images",
          "title": "Informative images have a text alternative",
          "status": "non_compliant",
          "method": "automated",
          "finding": "The logo image inside the home link has no alt attribute.",
          "affected_elements": ["header a.logo > img"],
          "faulty_code": "<a class=\"logo\" href=\"/\"><img src=\"/logo.svg\"></a>",
          "expected_correction": "Give the logo image an alt attribute naming the destination, e.g. alt=\"Example, home page\"."
        },
        {
          "number": "3.2",
          "topic": "Colors",
          "title": "Contrast between text and background is sufficient",
          "status": "compliant",
          "method": "automated"
        }
      ]
    }
  ]
}
```

### Fields

| Field                                  | Required | Used for                                                                                              |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `date`                                 | no       | Header, prompts, audit identity                                                                       |
| `reference_framework`                  | no       | Header, prompts (defaults to `RGAA`)                                                                  |
| `environment`                          | no       | Free key/value pairs shown in the header and in prompts                                               |
| `audited_pages`, `summary`             | no       | Ignored: every count is recomputed from `pages`                                                       |
| `pages[]`                              | **yes**  | Must contain at least one page                                                                        |
| `pages[].url`                          | **yes**  | Page link; the path and query string identify the page (the host is ignored)                          |
| `pages[].audited_at`                   | no       | Prompts, audit identity                                                                               |
| `pages[].http_status`                  | no       | Ignored                                                                                               |
| `pages[].criteria[]`                   | **yes**  | One result per criterion                                                                              |
| `criteria[].number`                    | **yes**  | Criterion number, as a **string** (`"3.10"`, not `3.1`)                                               |
| `criteria[].status`                    | **yes**  | `non_compliant`, `to_verify`, `compliant` or `not_applicable`                                         |
| `criteria[].topic`, `criteria[].title` | no       | The first value found for a given number is used on every page                                        |
| `criteria[].method`                    | no       | `automated`, `agent_judgment` and `manual_required` get readable labels; other values are shown as is |
| `criteria[].finding`                   | no       | What was observed                                                                                     |
| `criteria[].affected_elements`         | no       | CSS selectors of the elements concerned                                                               |
| `criteria[].faulty_code`               | no       | Captured code, usually an HTML fragment; `…` or `...` marks truncated parts                           |
| `criteria[].expected_correction`       | no       | Recommended fix                                                                                       |

Only `non_compliant` and `to_verify` entries can be marked as done and get agent prompts. The viewer also accepts unknown statuses: they are displayed as is but cannot be marked. Extra properties are ignored.

### Validating a file

```sh
# Node.js
npx ajv-cli@5 validate --spec=draft2020 -s audit.schema.json -d my-audit.json

# Python (pip install jsonschema)
python3 -c "import json, jsonschema; jsonschema.validate(json.load(open('my-audit.json')), json.load(open('audit.schema.json'))); print('valid')"
```

## Using the viewer

### Header

The header shows the framework, the audit date, the number of pages, the file name and the environment. Below it, the status counts and a progress meter (done entries among the markable entries shown) both follow the current filters.

### Views

- **By criterion** (the default): one group per criterion, in RGAA order. The group header shows the criterion number, title and topic, the number of entries shown with their statuses, and the scope (for example, *scope 22/22 pages*). It also has the all-pages controls described below and a link to the official criterion page.
- **By page**: one group per page, in the order of the file. The group header shows the path, the counts, the done progress for the entries shown, and a link to the page.

**Collapse all**, **Rows** and **Expand all** switch between group headers only, groups with one-line entries (the default), and every entry expanded.

### Filters

Filters are in the left column; below 768 px they move to a drawer opened with the **Filters** button. Values within a filter are combined with OR, and different filters are combined with AND.

| Filter     | Values                                                                                                                                                                           | Default                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Search     | Every word must appear in the criterion number, title, topic, page, finding, selectors, faulty code or expected correction. Case and accents are ignored.                        | empty                     |
| Status     | Non-compliant, To verify, Compliant, Not applicable                                                                                                                              | Non-compliant + To verify |
| Done state | Not done, Done, Not markable (compliant and not applicable entries)                                                                                                              | all                       |
| Topic      | The topics present in the audit                                                                                                                                                  | all                       |
| Method     | The detection methods present in the audit                                                                                                                                       | all                       |
| Scope      | Min–max number of pages where the criterion is non-compliant or to verify. A min close to the page count keeps issues shared by (almost) every page; a low max keeps local ones. | 0 to page count           |
| Pages      | The audited pages                                                                                                                                                                | all                       |

Search matches are highlighted. When the match is outside the visible excerpt, the excerpt is re-centred on it, or a *match in: selectors / code / correction* label tells you where it was found. **Reset** restores the defaults.

### Tracking fixes

- Tick the checkbox of an entry to mark it as done. Done entries are dimmed.
- In *By criterion*, the checkbox of a group header acts on **every** non-compliant and to-verify entry of that criterion, on all pages, whatever the filters. It can be unticked, partially ticked or ticked; the label next to it (*All pages: 4/22 done*) counts all pages. The same action is available in an entry's details (**Mark 3.2 done on all pages**).
- A grouped action shows an **Undo** notification for 8 seconds; the countdown pauses while the notification is hovered or focused. Undo restores the exact previous state, including entries that were ticked individually.
- The list order does not change under your cursor. Done entries move to the end of their group, and fully done groups to the end of the list, at the next refresh (a filter or view change, or a reload).

### Entry details

When an entry is expanded, it shows:

- its detection method and topic, plus the criterion's scope in *By page*;
- links to the audited page and to the official criterion;
- the finding;
- the affected elements, each with a copy button plus **Copy all**;
- the faulty code, one tag per line and coloured, with a copy button that copies the original text;
- the expected correction;
- the action buttons.

### Agent prompts

Prompts are Markdown texts written in English, ready to paste into a coding agent working on the audited site's repository. They exist for non-compliant and to-verify entries only.

| Prompt                                         | Where                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Entry**: one page × one criterion            | Terminal icon at the end of each row, **Copy prompt** in the details, key `p`                    |
| **All pages**: every open entry of a criterion | **Copy prompt (all pages)** in the criterion header (*By criterion*) and in the details, key `P` |

An entry prompt contains:

- the criterion and the link to the official criterion and tests;
- your project context;
- the audit context: page URL, audit timestamp, framework, environment, status, method, and scope, including the other pages where the same faulty code was captured;
- the finding, selectors, faulty code and expected correction;
- instructions to:
  1. locate the source;
  2. confirm the defect before changing anything;
  3. fix it;
  4. look for other occurrences of the same pattern;
  5. verify the fix and run the existing lint and test commands;
  6. leave the changes uncommitted.

An all-pages prompt:

- leaves out entries already marked as done and says how many were left out;
- groups pages sharing the same faulty code into one *issue*, or the same finding when no code was captured. Issues are listed by number of pages, largest first. Fields that are identical within an issue are written once; only the differences are detailed page by page;
- is disabled and labelled **Nothing left to fix** when every entry of the criterion is done.

For **to-verify** entries, the agent is asked to evaluate first, state its conclusion (non-compliant, compliant or not applicable) with a justification, and fix only what is confirmed non-compliant. A criterion that mixes both statuses gets both sets of instructions.

**Project context**: open **Prompt settings** (terminal icon in the header) and describe the project, for example the stack, where pages, components and styles live, conventions, and lint and test commands. The text is added to every prompt under `## Project context`. It is empty by default, and the section is omitted while it stays empty. It is saved as you type, and **Clear** empties it.

Example (entry prompt, without project context):

````markdown
# Fix RGAA criterion 1.1 on /

Criterion 1.1 (Images): Informative images have a text alternative
Official criterion and tests: https://accessibilite.numerique.gouv.fr/methode/criteres-et-tests/#1.1

## Audit context

- Page: https://www.example.com/ (audited 2026-01-15T09:30:00Z)
- Audit: RGAA 4.1, 2026-01-15 (environment: browser Chromium 140)
- Status: Non-compliant; detection method: automated
- Scope: non-compliant or to verify on 1/2 audited pages.

## Finding

The logo image inside the home link has no alt attribute.

## Affected elements

- `header a.logo > img`

## Faulty code

Captured during the audit; "…" or "..." marks truncated parts.

```html
<a class="logo" href="/"><img src="/logo.svg"></a>
```

## Expected correction

Give the logo image an alt attribute naming the destination, e.g. alt="Example, home page".

## Instructions

1. Locate where the faulty markup or styles come from in the repository (templates, components, layouts, stylesheets, scripts), starting from the affected elements and the faulty code.
2. Before changing anything, confirm each defect in the source code and in the rendered page. If a defect cannot be reproduced, leave it and explain why.
3. Fix each confirmed defect as described in its expected correction (or, without one, as required by the criterion), without changing the visual design beyond what the fix requires.
4. Search the codebase for other occurrences of the same pattern (shared components, similar markup or classes) and fix them as well.
5. Verify the fix: check the affected elements again in the rendered page (for instance recompute contrast ratios or test keyboard behaviour, depending on the criterion), then run the existing lint and test commands.
6. Do not commit: leave the changes uncommitted for review.
````

### Keyboard shortcuts

Shortcuts are inactive while typing in a field. Press `?` in the viewer to see this list.

| Keys           | Action                                                              |
| -------------- | ------------------------------------------------------------------- |
| `/`            | Focus the search field                                              |
| `Esc`          | Clear the search; close the filters drawer or a dialog              |
| `v`            | Switch view (by criterion / by page)                                |
| `j` / `k`      | Next / previous entry                                               |
| `J` / `K`      | Next / previous group                                               |
| `x`            | Mark / unmark the focused entry as done                             |
| `X`            | Mark / unmark the focused entry's criterion on all pages            |
| `Enter` or `o` | Expand / collapse the focused entry                                 |
| `+` / `-`      | Expand more / collapse more (group headers, rows, full details)     |
| `p`            | Copy the agent prompt of the focused entry                          |
| `P`            | Copy the agent prompt for all open entries of the focused criterion |
| `?`            | Show the shortcuts                                                  |

### Theme

The theme follows the operating system setting until you use the theme button in the header. After that, your choice is remembered.

## Storage and privacy

- The audit file is read locally. The only network requests are the two library scripts, plus any links you choose to open.
- Everything is kept in the browser's `localStorage` under the `rgaaViewer:v1:` prefix:

  | Key                            | Content                                                                                                   |
  | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
  | `rgaaViewer:v1:audit`          | The last loaded audit and its file name, gzip-compressed and base64-encoded (a fraction of the JSON size) |
  | `rgaaViewer:v1:done:<auditId>` | The done entries of one audit, as `path\|number` keys                                                     |
  | `rgaaViewer:v1:theme`          | `light` or `dark`, once chosen manually                                                                   |
  | `rgaaViewer:v1:promptContext`  | The project context used in prompts                                                                       |

- **Audit identity**: done states are stored per audit. An audit is identified by its `date` and all `audited_at` values (hashed). Loading the same file again restores its progress. A new audit run starts from an empty state, even on the same day, and the states of previous audits are kept.
- **File location**: when the page is opened from disk, the browser ties `localStorage` to the file's location. Moving or renaming the HTML file therefore starts from an empty storage.
- If an audit is too large to be stored, a notice says so and the file has to be loaded again next time.
- **Purge data** (header) deletes every key listed above after confirmation.

## Architecture

The project is a single HTML file with no build step:

- A small inline script applies the theme before the first paint.
- A `<style type="text/tailwindcss">` block holds the design tokens (CSS variables for light and dark themes) and the component classes, compiled at runtime by the Tailwind browser build.
- An inline `<script>` holds all the logic, in this order:
  1. storage helpers and constants;
  2. accent- and case-insensitive search with offset mapping, used for highlighting;
  3. a tolerant tokenizer and renderer for faulty code;
  4. `parseAudit`, which normalizes the JSON into a model kept outside Alpine's reactivity;
  5. the prompt builders, `buildEntryPrompt` and `buildCriterionPrompt`;
  6. the Alpine component `app`: filters, `refresh` (builds the ordered list snapshot), `recount` (facet counts and progress), done state, undo, rendering helpers and keyboard handling.

Performance notes:

- The list rows are rendered as static HTML strings with delegated event handlers, and done or expanded state is synced directly in the DOM.
- Groups use `content-visibility: auto`.
- About 2,300 rows render in under a second in headless Chromium.

To use the viewer offline, download the two library files, put them next to the HTML file and change the two `src` attributes in its `<head>`. To update a library, change its pinned version in the URL.

## Limitations

- Done states cannot be exported or imported; they live in one browser, for one file location.
- Only the last loaded audit is memorized. The done states of other audits are kept and come back when their file is loaded again.
- The faulty-code formatter splits tags onto separate lines and colours them. It does not re-indent or validate HTML.
- The input format carries no WCAG level, so there is no A / AA filter.
- Firefox and Safari are untested.
