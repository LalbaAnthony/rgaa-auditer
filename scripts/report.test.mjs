import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AuditError, FAULTY_CODE_MAX_LENGTH, buildPageEntry, checkReportFileDate, listRemaining, loadCatalog, mergePage,
    parsePrompt, readReport, reportDateFromPath, validateReport, validateSubmission,
} from './report.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'audit-report.mjs');
const catalog = loadCatalog();
const URL_A = 'https://www.example.com/';
const URL_B = 'https://www.example.com/contact?tab=1';
const ENV = { playwright_mcp: '0.0.83', chromium: '155.0.8059.12' };

// A valid submission: every criterion answered, with one entry of each status.
function makeSubmission(url = URL_A, env = ENV) {
    const criteria = catalog.criteria.map(ref => {
        if (ref.method === 'manual_required') return { number: ref.number, status: 'to_verify', finding: 'A human must check this.' };
        if (ref.method === 'agent_judgment') return { number: ref.number, status: 'not_applicable' };
        return { number: ref.number, status: 'compliant' };
    });
    criteria[0] = {
        number: '1.1',
        status: 'non_compliant',
        affected_elements: ['header a.logo > img'],
        finding: 'The logo image has no alt attribute.',
        faulty_code: '<a class="logo" href="/"><img src="/logo.svg"></a>',
        expected_correction: 'Add alt="Example, home page" to the logo image.',
    };
    return { environment: { ...env }, page: { url, http_status: 200, criteria } };
}

const errorSubmission = (url = URL_B) => ({ environment: { ...ENV }, page: { url, http_status: 404, error: 'HTTP 404 Not Found', criteria: [] } });
const criterion = (sub, number) => sub.page.criteria.find(c => c.number === number);
const problemsOf = sub => validateSubmission(sub, { url: sub.page.url, catalog });

function tempDir() {
    return mkdtempSync(join(tmpdir(), 'rgaa-report-'));
}

describe('loadCatalog', () => {
    test('lists the 106 RGAA criteria with the number of criteria of each topic', () => {
        assert.equal(catalog.referenceFramework, 'RGAA 4.1.2');
        assert.equal(catalog.criteria.length, 106);
        const perTopic = new Map();
        for (const c of catalog.criteria) {
            const theme = c.number.split('.')[0];
            perTopic.set(theme, (perTopic.get(theme) || 0) + 1);
        }
        assert.deepEqual([...perTopic.values()], [9, 2, 3, 13, 8, 2, 5, 10, 4, 14, 13, 11, 12]);
        const topicsPerTheme = new Map();
        for (const c of catalog.criteria) topicsPerTheme.set(c.number.split('.')[0], new Set([...(topicsPerTheme.get(c.number.split('.')[0]) || []), c.topic]));
        for (const topics of topicsPerTheme.values()) assert.equal(topics.size, 1);
    });

    test('rejects an invalid criteria file', () => {
        const dir = tempDir();
        try {
            const file = join(dir, 'criteria.json');
            writeFileSync(file, JSON.stringify({ reference_framework: 'X', criteria: [{ number: '1.1', topic: 'T', title: 'A', method: 'guess' }, { number: '1.1', topic: 'T', title: 'B', method: 'automated' }] }));
            assert.throws(() => loadCatalog(file), e => e instanceof AuditError && e.problems.some(p => p.includes('method')) && e.problems.some(p => p.includes('duplicate')));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('parsePrompt', () => {
    const prompt = (report, pages) => `# Prompt\n\n\`\`\`audit-report\n${report}\n\`\`\`\n\nText.\n\n\`\`\`audit-pages\n${pages}\n\`\`\`\n\n\`\`\`json\n{"not": "a parameter"}\n\`\`\`\n`;

    test('reads the report path, its date and the page URLs in order', () => {
        const p = parsePrompt(prompt('audits/audit_example-com_2026-10-09.json', `${URL_A}\n\n  ${URL_B}  \n`));
        assert.deepEqual(p, { report: 'audits/audit_example-com_2026-10-09.json', date: '2026-10-09', urls: [URL_A, URL_B] });
    });

    test('accepts CRLF line endings, a BOM and Windows separators', () => {
        const p = parsePrompt('﻿' + prompt('audits\\audit_2026-10-09.json', URL_A).replace(/\n/g, '\r\n'));
        assert.equal(p.report, 'audits/audit_2026-10-09.json');
        assert.deepEqual(p.urls, [URL_A]);
    });

    const cases = [
        ['a missing report block', 'no blocks here', /audit-report block, found 0/],
        ['two report lines', prompt('audits/a_2026-10-09.json\naudits/b_2026-10-09.json', URL_A), /exactly one line/],
        ['a report outside audits/', prompt('reports/a_2026-10-09.json', URL_A), /must look like/],
        ['a report without a final date', prompt('audits/audit.json', URL_A), /must look like/],
        ['an impossible date', prompt('audits/a_2026-02-30.json', URL_A), /valid date/],
        ['a relative URL', prompt('audits/a_2026-10-09.json', '/contact'), /invalid page URL/],
        ['a non-http URL', prompt('audits/a_2026-10-09.json', 'ftp://example.com/'), /invalid page URL/],
        ['a URL with a quote', prompt('audits/a_2026-10-09.json', "https://example.com/it's"), /invalid page URL/],
        ['a duplicate URL', prompt('audits/a_2026-10-09.json', `${URL_A}\n${URL_A}`), /duplicate page URL/],
        ['an empty page list', prompt('audits/a_2026-10-09.json', ''), /contains no URL/],
    ];
    for (const [name, text, pattern] of cases) {
        test(`rejects ${name}`, () => {
            assert.throws(() => parsePrompt(text), e => e instanceof AuditError && e.problems.some(p => pattern.test(p)));
        });
    }

    test('parses the parameters of audit-prompt.example.md', () => {
        const example = readFileSync(resolve(dirname(CLI), '..', 'audit-prompt.example.md'), 'utf8');
        const p = parsePrompt(example);
        assert.match(p.report, /^audits\/.+_\d{4}-\d{2}-\d{2}\.json$/);
        assert.ok(p.urls.length > 0);
    });
});

describe('reportDateFromPath and listRemaining', () => {
    test('extracts the final date of the file name', () => {
        assert.equal(reportDateFromPath('audits/site_a_2026-01-15.json'), '2026-01-15');
        assert.throws(() => reportDateFromPath('audits/site.json'), AuditError);
    });

    test('keeps the prompt order and ignores pages that are not in the list', () => {
        const report = { pages: [{ url: URL_B }, { url: 'https://other.example/' }] };
        assert.deepEqual(listRemaining([URL_A, URL_B, 'https://www.example.com/x'], report), [URL_A, 'https://www.example.com/x']);
        assert.deepEqual(listRemaining([URL_A], null), [URL_A]);
    });
});

describe('validateSubmission', () => {
    test('accepts a complete submission and a page that could not be audited', () => {
        assert.deepEqual(problemsOf(makeSubmission()), []);
        assert.deepEqual(problemsOf(errorSubmission()), []);
        const timeout = errorSubmission();
        delete timeout.page.http_status;
        timeout.page.error = 'Navigation timeout after 60 s';
        assert.deepEqual(problemsOf(timeout), []);
    });

    test('accepts a final_url that differs from the URL', () => {
        const sub = makeSubmission();
        sub.page.final_url = 'https://www.example.com/home';
        assert.deepEqual(problemsOf(sub), []);
    });

    const cases = [
        ['a page URL other than the target', s => { s.page.url = 'https://www.example.com'; }, /must be exactly/],
        ['a missing environment key', s => { delete s.environment.chromium; }, /missing "chromium"/],
        ['an unknown top-level key', s => { s.summary = []; }, /unknown property "summary"/],
        ['a missing criterion', s => { s.page.criteria.pop(); }, /missing 1 of the 106 criteria: 13\.12/],
        ['a duplicated criterion', s => { s.page.criteria.push({ number: '2.1', status: 'compliant' }); }, /criterion 2\.1: listed more than once/],
        ['an unknown criterion number', s => { s.page.criteria.push({ number: '14.1', status: 'compliant' }); }, /unknown criterion number "14\.1"/],
        ['a numeric criterion number', s => { s.page.criteria[1].number = 1.2; }, /unknown criterion number 1\.2/],
        ['topic, title or method', s => { criterion(s, '2.1').method = 'automated'; }, /do not provide them/],
        ['an unknown status', s => { criterion(s, '2.1').status = 'partially_compliant'; }, /status must be one of/],
        ['a verdict on a manual_required criterion', s => { Object.assign(criterion(s, '4.2'), { status: 'compliant' }); delete criterion(s, '4.2').finding; }, /not allowed for a manual_required/],
        ['a non_compliant entry without expected_correction', s => { delete criterion(s, '1.1').expected_correction; }, /expected_correction is required/],
        ['a to_verify entry without finding', s => { Object.assign(criterion(s, '2.1'), { status: 'to_verify' }); }, /finding is required for a to_verify/],
        ['details on a compliant entry', s => { criterion(s, '2.1').faulty_code = '<iframe>'; }, /faulty_code not allowed for a compliant/],
        ['an empty affected_elements array', s => { criterion(s, '1.1').affected_elements = []; }, /affected_elements must be a non-empty array/],
        ['a blank finding', s => { criterion(s, '1.1').finding = '  '; }, /finding must be a non-empty string/],
        ['a faulty_code that is too long', s => { criterion(s, '1.1').faulty_code = 'x'.repeat(FAULTY_CODE_MAX_LENGTH + 1); }, /characters long/],
        ['an audited page without http_status', s => { delete s.page.http_status; }, /http_status is required/],
        ['an out-of-range http_status', s => { s.page.http_status = 1000; }, /between 100 and 599/],
        ['a final_url equal to the URL', s => { s.page.final_url = s.page.url; }, /must be omitted when it equals url/],
        ['an error page with criteria', s => { s.page.error = 'HTTP 500'; }, /must be an empty array when page\.error is set/],
    ];
    for (const [name, mutate, pattern] of cases) {
        test(`rejects ${name}`, () => {
            const sub = makeSubmission();
            mutate(sub);
            const problems = validateSubmission(sub, { url: URL_A, catalog });
            assert.ok(problems.some(p => pattern.test(p)), `no problem matches ${pattern}: ${JSON.stringify(problems)}`);
        });
    }

    test('allows a non_compliant entry without element when none is concerned', () => {
        const sub = makeSubmission();
        Object.assign(criterion(sub, '9.2'), { status: 'non_compliant', finding: 'The page has no main element.', expected_correction: 'Wrap the main content in a main element.' });
        assert.deepEqual(problemsOf(sub), []);
    });

    test('allows not_applicable on a manual_required criterion', () => {
        const sub = makeSubmission();
        Object.assign(criterion(sub, '4.2'), { status: 'not_applicable', finding: 'No media on the page.' });
        assert.deepEqual(problemsOf(sub), []);
    });
});

describe('buildPageEntry', () => {
    test('sorts the criteria in canonical order and adds topic, title and method', () => {
        const sub = makeSubmission();
        sub.page.criteria.reverse();
        criterion(sub, '1.1').finding = '  The logo image has no alt attribute.  ';
        const page = buildPageEntry(sub.page, catalog, '2026-10-09T10:00:00Z');
        assert.deepEqual(Object.keys(page), ['url', 'audited_at', 'http_status', 'criteria']);
        assert.deepEqual(page.criteria.map(c => c.number), catalog.criteria.map(c => c.number));
        assert.deepEqual(Object.keys(page.criteria[0]), ['number', 'topic', 'title', 'status', 'method', 'affected_elements', 'finding', 'faulty_code', 'expected_correction']);
        assert.equal(page.criteria[0].finding, 'The logo image has no alt attribute.');
        const media = page.criteria.find(c => c.number === '4.1');
        assert.equal(media.title, catalog.byNumber.get('4.1').title);
        assert.equal(media.topic, 'Multimedia');
        assert.equal(media.method, 'agent_judgment');
    });

    test('keeps an empty criteria array for a page that could not be audited', () => {
        const page = buildPageEntry(errorSubmission().page, catalog, '2026-10-09T10:00:00Z');
        assert.deepEqual(page, { url: URL_B, audited_at: '2026-10-09T10:00:00Z', http_status: 404, error: 'HTTP 404 Not Found', criteria: [] });
    });
});

describe('mergePage', () => {
    let dir;
    before(() => { dir = tempDir(); });
    after(() => rmSync(dir, { recursive: true, force: true }));

    test('creates the report on the first merge, then appends pages in order', () => {
        const reportPath = join(dir, 'audits', 'site_2026-10-09.json');
        const first = mergePage({ reportPath, url: URL_A, submission: makeSubmission(URL_A), catalog, now: new Date('2026-10-09T10:00:00.123Z') });
        assert.equal(first.created, true);
        assert.deepEqual(Object.keys(first.report), ['date', 'reference_framework', 'environment', 'pages']);
        assert.equal(first.report.date, '2026-10-09');
        assert.equal(first.report.reference_framework, 'RGAA 4.1.2');
        assert.equal(first.page.audited_at, '2026-10-09T10:00:00Z');

        const second = mergePage({ reportPath, url: URL_B, submission: errorSubmission(URL_B), catalog, now: new Date('2026-10-09T10:30:00Z') });
        assert.equal(second.created, false);
        const saved = readReport(reportPath);
        assert.deepEqual(saved.pages.map(p => p.url), [URL_A, URL_B]);
        assert.deepEqual(saved.environment, ENV);
        assert.deepEqual(validateReport(saved, catalog), []);
        assert.deepEqual(checkReportFileDate(saved, reportPath), []);
        assert.ok(readFileSync(reportPath, 'utf8').endsWith('}\n'));
        assert.deepEqual(readdirSync(dirname(reportPath)), ['site_2026-10-09.json']);
    });

    test('keeps the environment of the first page', () => {
        const reportPath = join(dir, 'audits', 'env_2026-10-09.json');
        mergePage({ reportPath, url: URL_A, submission: makeSubmission(URL_A), catalog });
        mergePage({ reportPath, url: URL_B, submission: makeSubmission(URL_B, { playwright_mcp: '9.9.9', chromium: '999' }), catalog });
        assert.deepEqual(readReport(reportPath).environment, ENV);
    });

    test('refuses a page that is already in the report and leaves the file untouched', () => {
        const reportPath = join(dir, 'audits', 'dup_2026-10-09.json');
        mergePage({ reportPath, url: URL_A, submission: makeSubmission(URL_A), catalog });
        const before = readFileSync(reportPath, 'utf8');
        assert.throws(() => mergePage({ reportPath, url: URL_A, submission: makeSubmission(URL_A), catalog }), /already in/);
        assert.equal(readFileSync(reportPath, 'utf8'), before);
    });

    test('writes nothing when the submission is invalid', () => {
        const reportPath = join(dir, 'audits', 'invalid_2026-10-09.json');
        const sub = makeSubmission(URL_A);
        sub.page.criteria.pop();
        assert.throws(() => mergePage({ reportPath, url: URL_A, submission: sub, catalog }), e => e instanceof AuditError && e.problems.length === 1);
        assert.equal(existsSync(reportPath), false);
    });

    test('refuses to merge into a report that was edited by hand', () => {
        const reportPath = join(dir, 'audits', 'edited_2026-10-09.json');
        const { report } = mergePage({ reportPath, url: URL_A, submission: makeSubmission(URL_A), catalog });
        report.pages[0].criteria[0].title = 'Edited title';
        writeFileSync(reportPath, JSON.stringify(report));
        assert.throws(() => mergePage({ reportPath, url: URL_B, submission: makeSubmission(URL_B), catalog }), e => e.problems.some(p => p.includes('title must be')));
    });

    test('requires a report file name ending with a date', () => {
        assert.throws(() => mergePage({ reportPath: join(dir, 'audits', 'nodate.json'), url: URL_A, submission: makeSubmission(URL_A), catalog }), /_YYYY-MM-DD\.json/);
    });
});

describe('validateReport', () => {
    const valid = () => ({
        date: '2026-10-09',
        reference_framework: 'RGAA 4.1.2',
        environment: { ...ENV },
        pages: [buildPageEntry(makeSubmission(URL_A).page, catalog, '2026-10-09T10:00:00Z')],
    });

    test('accepts a report built by the merge', () => {
        assert.deepEqual(validateReport(valid(), catalog), []);
    });

    const cases = [
        ['the removed summary fields', r => { r.summary = []; r.audited_pages = 1; }, /unknown properties "summary", "audited_pages"/],
        ['another framework', r => { r.reference_framework = 'RGAA 4.1'; }, /reference_framework must be "RGAA 4\.1\.2"/],
        ['criteria out of canonical order', r => { const c = r.pages[0].criteria; [c[0], c[1]] = [c[1], c[0]]; }, /number must be "1\.1"/],
        ['a changed method', r => { r.pages[0].criteria[0].method = 'agent_judgment'; }, /method must be "automated"/],
        ['a missing criterion', r => { r.pages[0].criteria.pop(); }, /must list the 106 criteria/],
        ['a non-UTC timestamp', r => { r.pages[0].audited_at = '2026-10-09 10:00'; }, /ISO 8601 UTC/],
        ['a duplicated page', r => { r.pages.push(r.pages[0]); }, /appears more than once/],
        ['no page', r => { r.pages = []; }, /non-empty array/],
    ];
    for (const [name, mutate, pattern] of cases) {
        test(`rejects ${name}`, () => {
            const r = valid();
            mutate(r);
            const problems = validateReport(r, catalog);
            assert.ok(problems.some(p => pattern.test(p)), `no problem matches ${pattern}: ${JSON.stringify(problems)}`);
        });
    }

    test('detects a date that differs from the file name', () => {
        assert.deepEqual(checkReportFileDate(valid(), 'audits/x_2026-10-10.json'), ['report.date "2026-10-09" does not match the date in the file name (2026-10-10)']);
    });
});

describe('command line', () => {
    let dir;
    const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });
    before(() => {
        dir = tempDir();
        writeFileSync(join(dir, 'prompt.md'), `\`\`\`audit-report\naudits/cli_2026-10-09.json\n\`\`\`\n\n\`\`\`audit-pages\n${URL_A}\n${URL_B}\n\`\`\`\n`);
        writeFileSync(join(dir, 'page-a.json'), JSON.stringify(makeSubmission(URL_A)));
        writeFileSync(join(dir, 'page-b.json'), JSON.stringify(errorSubmission(URL_B)));
        const bad = makeSubmission(URL_A);
        bad.page.criteria.pop();
        writeFileSync(join(dir, 'page-bad.json'), JSON.stringify(bad));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    test('remaining lists every page before the first merge', () => {
        const r = cli('remaining', '--prompt', 'prompt.md');
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), { report: 'audits/cli_2026-10-09.json', total: 2, remaining: [URL_A, URL_B] });
    });

    test('merge reports validation problems with exit code 1 and writes nothing', () => {
        const r = cli('merge', '--report', 'audits/cli_2026-10-09.json', '--url', URL_A, '--page', 'page-bad.json');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /missing 1 of the 106 criteria: 13\.12/);
        assert.equal(existsSync(join(dir, 'audits', 'cli_2026-10-09.json')), false);
    });

    test('merge appends pages, then remaining and validate reflect them', () => {
        let r = cli('merge', '--report', 'audits/cli_2026-10-09.json', '--url', URL_A, '--page', 'page-a.json');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^Merged https:\/\/www\.example\.com\/ into audits\/cli_2026-10-09\.json \(page 1, new report\): 1 non_compliant, 12 to_verify, \d+ compliant, \d+ not_applicable\.\n$/);
        r = cli('merge', '--report', 'audits/cli_2026-10-09.json', '--url', URL_B, '--page', 'page-b.json');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /as not audited: HTTP 404 Not Found/);
        r = cli('remaining', '--prompt', 'prompt.md');
        assert.deepEqual(JSON.parse(r.stdout).remaining, []);
        r = cli('validate', '--report', 'audits/cli_2026-10-09.json');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /is valid: 2 page\(s\), 1 not audited\./);
    });

    test('validate fails on a missing report', () => {
        const r = cli('validate', '--report', 'audits/none_2026-10-09.json');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /does not exist/);
    });

    test('usage errors exit with code 2', () => {
        assert.equal(cli().status, 2);
        assert.equal(cli('merge', '--report', 'x').status, 2);
        assert.equal(cli('remaining', '--prompt', 'prompt.md', '--force', 'yes').status, 2);
    });

    test('remaining fails on a missing prompt', () => {
        const r = cli('remaining', '--prompt', 'missing.md');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /ENOENT|cannot read/);
    });
});
