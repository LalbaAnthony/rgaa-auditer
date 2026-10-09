// Tests of the viewer logic: the main inline script of index.html runs in a VM context and exposes its pure
// functions on window.RgaaViewer. Reports are built with the real merge code, so producer and viewer stay in sync.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildPageEntry, loadCatalog } from '../scripts/report.mjs';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
const main = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function parseAudit'));
const window = {};
runInNewContext(main, { window, URL, document: { addEventListener() { } } });
const { parseAudit, buildEntryPrompt, buildCriterionPrompt } = window.RgaaViewer;

// Values created in the VM context have their own prototypes: compare plain copies.
const plain = v => JSON.parse(JSON.stringify(v));
const catalog = loadCatalog();
const ENV = { playwright_mcp: '0.0.83', chromium: '155.0.8059.12' };

function auditedPage(url, auditedAt, extra = {}) {
    const criteria = catalog.criteria.map(ref => (ref.method === 'manual_required'
        ? { number: ref.number, status: 'to_verify', finding: 'A human must check this.' }
        : { number: ref.number, status: 'compliant' }));
    criteria[0] = {
        number: '1.1', status: 'non_compliant', affected_elements: ['header img'], finding: 'The logo has no alt attribute.',
        faulty_code: '<img src="/logo.svg">', expected_correction: 'Add an alt attribute.',
    };
    return buildPageEntry({ url, http_status: 200, criteria, ...extra }, catalog, auditedAt);
}

function report(pages, date = '2026-10-09') {
    return JSON.stringify({ date, reference_framework: catalog.referenceFramework, environment: ENV, pages });
}

const HOME = auditedPage('https://www.example.com/', '2026-10-09T10:00:00Z', { final_url: 'https://www.example.com/home' });
const CONTACT = auditedPage('https://www.example.com/contact', '2026-10-09T10:30:00Z');
const MISSING = buildPageEntry({ url: 'https://www.example.com/old', http_status: 404, error: 'HTTP 404 Not Found', criteria: [] }, catalog, '2026-10-09T11:00:00Z');

describe('parseAudit', () => {
    test('reads a report written by the merge, including a page that could not be audited', () => {
        const A = parseAudit(report([HOME, MISSING, CONTACT]));
        assert.equal(A.pages.length, 3);
        assert.equal(A.auditedCount, 2);
        assert.equal(A.criteria.length, 106);
        assert.equal(A.entries.length, 212);
        assert.deepEqual(plain(A.pages.map(p => p.error)), ['', 'HTTP 404 Not Found', '']);
        assert.equal(A.pages[0].finalUrl, 'https://www.example.com/home');
        assert.equal(A.pages[1].finalUrl, '');
        assert.equal(A.criteria[0].title, catalog.criteria[0].title);
        assert.equal(A.meta.reference, 'RGAA 4.1.2');
        assert.equal(A.scope[0], 2);
    });

    test('identifies done marks by page URL, page audit timestamp and criterion', () => {
        const A = parseAudit(report([HOME]));
        const e = A.entries[0];
        assert.equal(e.doneId, 'https://www.example.com/|2026-10-09T10:00:00Z|1.1');
        assert.equal(A.keyByDoneId.get(e.doneId), e.key);
    });

    test('keeps the same storage partition when pages are added, not for another date or site', () => {
        const partial = parseAudit(report([HOME]));
        const complete = parseAudit(report([HOME, MISSING, CONTACT]));
        assert.equal(complete.reportId, partial.reportId);
        assert.notEqual(parseAudit(report([HOME], '2026-10-10')).reportId, partial.reportId);
        assert.notEqual(parseAudit(report([auditedPage('https://other.example/', '2026-10-09T10:00:00Z')])).reportId, partial.reportId);
    });

    test('accepts an error page without criteria, rejects an audited page without criteria', () => {
        const { criteria, ...withoutCriteria } = MISSING;
        assert.equal(parseAudit(report([HOME, withoutCriteria])).auditedCount, 1);
        const { criteria: c2, ...brokenPage } = CONTACT;
        assert.throws(() => parseAudit(report([brokenPage])), /page #1 has no "criteria" array/);
        assert.throws(() => parseAudit('{"pages": []}'), /missing or empty "pages" array/);
    });
});

describe('agent prompts', () => {
    test('the entry prompt mentions the redirection and counts audited pages only', () => {
        const A = parseAudit(report([HOME, MISSING, CONTACT]));
        const prompt = buildEntryPrompt(A, A.entries[0], '');
        assert.match(prompt, /^# Fix RGAA criterion 1\.1 on \/\n/);
        assert.match(prompt, /- Page: https:\/\/www\.example\.com\/, redirected to https:\/\/www\.example\.com\/home \(audited 2026-10-09T10:00:00Z\)/);
        assert.match(prompt, /- Audit: RGAA 4\.1\.2, 2026-10-09 \(environment: playwright_mcp 0\.0\.83, chromium 155\.0\.8059\.12\)/);
        assert.match(prompt, /- Scope: non-compliant or to verify on 2\/2 audited pages; the cause may be shared/);
        assert.match(prompt, /- The same faulty code was also captured on: \/contact\./);
    });

    test('the all-pages prompt groups identical faulty code and leaves out done entries', () => {
        const A = parseAudit(report([HOME, MISSING, CONTACT]));
        const prompt = buildCriterionPrompt(A, 0, {}, 'Stack: static HTML.');
        assert.match(prompt, /## Project context\n\nStack: static HTML\./);
        assert.match(prompt, /### Issue 1: identical faulty code on 2 pages/);
        assert.match(prompt, /- https:\/\/www\.example\.com\/, redirected to https:\/\/www\.example\.com\/home \(Non-compliant, automated\)/);
        const contactKey = A.entries.find(e => e.path === '/contact' && e.number === '1.1').key;
        const partial = buildCriterionPrompt(A, 0, { [contactKey]: true }, '');
        assert.match(partial, /1 entry already marked as done in the audit viewer is left out\./);
        assert.equal(buildCriterionPrompt(A, 0, Object.fromEntries(A.critMarkable[0].map(k => [k, true])), ''), null);
    });
});
