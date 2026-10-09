// Audit report library: prompt parameters, page submissions, report validation and merge.
// Used by scripts/audit-report.mjs (CLI) and its tests. Node.js >= 20, no dependencies.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CRITERIA_FILE = join(ROOT, 'docs', 'rgaa-criteria.json');

export const STATUSES = Object.freeze(['non_compliant', 'to_verify', 'compliant', 'not_applicable']);
export const METHODS = Object.freeze(['automated', 'agent_judgment', 'manual_required']);
export const FAULTY_CODE_MAX_LENGTH = 500;

const MANUAL_STATUSES = new Set(['to_verify', 'not_applicable']);
const DETAIL_KEYS = ['affected_elements', 'finding', 'faulty_code', 'expected_correction'];
const INJECTED_KEYS = ['topic', 'title', 'method'];
const SUBMISSION_KEYS = ['environment', 'page'];
const SUBMISSION_PAGE_KEYS = ['url', 'final_url', 'http_status', 'error', 'criteria'];
const SUBMISSION_CRITERION_KEYS = ['number', 'status', ...DETAIL_KEYS];
const REPORT_KEYS = ['date', 'reference_framework', 'environment', 'pages'];
const REPORT_PAGE_KEYS = ['url', 'final_url', 'audited_at', 'http_status', 'error', 'criteria'];
const REPORT_CRITERION_KEYS = ['number', 'topic', 'title', 'status', 'method', ...DETAIL_KEYS];
const ENVIRONMENT_KEYS = ['playwright_mcp', 'chromium'];

// Report path written in the prompt: audits/<free name>_YYYY-MM-DD.json
const PROMPT_REPORT_RE = /^audits\/[^/\\]+_\d{4}-\d{2}-\d{2}\.json$/;
const REPORT_DATE_RE = /_(\d{4}-\d{2}-\d{2})\.json$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Characters that would break the shell command given to the agents, or a URL list line.
const UNSAFE_URL_CHARS_RE = /[\s'"`\\]/;

export class AuditError extends Error {
    constructor(message, problems = []) {
        super(message);
        this.name = 'AuditError';
        this.problems = problems;
    }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';

function isValidDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isHttpUrl(s) {
    if (typeof s !== 'string' || s === '' || UNSAFE_URL_CHARS_RE.test(s)) return false;
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function readText(file, label) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (e) {
        throw new AuditError(`cannot read the ${label} ${file}: ${e.message}`);
    }
    return text.replace(/^﻿/, '');
}

export function readJson(file, label) {
    const text = readText(file, label);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new AuditError(`the ${label} ${file} is not valid JSON: ${e.message}`);
    }
}

function checkKeys(obj, allowed, required, where, problems) {
    const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
    if (unknown.length) problems.push(`${where}: unknown ${unknown.length === 1 ? 'property' : 'properties'} ${unknown.map(k => JSON.stringify(k)).join(', ')}`);
    const missing = required.filter(k => obj[k] === undefined);
    if (missing.length) problems.push(`${where}: missing ${missing.map(k => JSON.stringify(k)).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Canonical criteria (docs/rgaa-criteria.json)
// ---------------------------------------------------------------------------

export function loadCatalog(file = CRITERIA_FILE) {
    const data = readJson(file, 'criteria file');
    const problems = [];
    if (!isPlainObject(data)) throw new AuditError(`the criteria file ${file} must contain a JSON object`);
    if (!isNonEmptyString(data.reference_framework)) problems.push('"reference_framework" must be a non-empty string');
    const list = Array.isArray(data.criteria) ? data.criteria : [];
    if (!list.length) problems.push('"criteria" must be a non-empty array');
    const byNumber = new Map();
    list.forEach((c, i) => {
        const where = `criteria[${i}]`;
        if (!isPlainObject(c)) {
            problems.push(`${where} must be an object`);
            return;
        }
        if (typeof c.number !== 'string' || !/^\d+\.\d+$/.test(c.number)) problems.push(`${where}: invalid number ${JSON.stringify(c.number)}`);
        else if (byNumber.has(c.number)) problems.push(`${where}: duplicate number ${c.number}`);
        if (!isNonEmptyString(c.topic)) problems.push(`${where}: "topic" must be a non-empty string`);
        if (!isNonEmptyString(c.title)) problems.push(`${where}: "title" must be a non-empty string`);
        if (!METHODS.includes(c.method)) problems.push(`${where}: "method" must be one of ${METHODS.join(', ')}`);
        byNumber.set(c.number, Object.freeze({ number: c.number, topic: c.topic, title: c.title, method: c.method }));
    });
    if (problems.length) throw new AuditError(`invalid criteria file ${file}`, problems);
    return Object.freeze({
        referenceFramework: data.reference_framework,
        criteria: Object.freeze([...byNumber.values()]),
        byNumber,
    });
}

// ---------------------------------------------------------------------------
// Audit parameters written in the prompt (```audit-report and ```audit-pages blocks)
// ---------------------------------------------------------------------------

export function parsePrompt(text) {
    const source = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const blocks = { 'audit-report': [], 'audit-pages': [] };
    for (const m of source.matchAll(/^```([^\s`]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)) {
        if (Object.hasOwn(blocks, m[1])) blocks[m[1]].push(m[2]);
    }
    const problems = [];
    const lines = body => body.split('\n').map(l => l.trim()).filter(Boolean);

    let report = null;
    if (blocks['audit-report'].length !== 1) {
        problems.push(`expected exactly one \`\`\`audit-report block, found ${blocks['audit-report'].length}`);
    } else {
        const values = lines(blocks['audit-report'][0]);
        if (values.length !== 1) problems.push(`the \`\`\`audit-report block must contain exactly one line, found ${values.length}`);
        else {
            report = values[0].replace(/\\/g, '/');
            if (!PROMPT_REPORT_RE.test(report)) problems.push(`report path ${JSON.stringify(values[0])} must look like audits/<name>_YYYY-MM-DD.json`);
            else if (!isValidDate(REPORT_DATE_RE.exec(report)[1])) problems.push(`report path ${JSON.stringify(values[0])} does not end with a valid date`);
        }
    }

    const urls = [];
    if (blocks['audit-pages'].length !== 1) {
        problems.push(`expected exactly one \`\`\`audit-pages block, found ${blocks['audit-pages'].length}`);
    } else {
        const seen = new Set();
        for (const line of lines(blocks['audit-pages'][0])) {
            if (!isHttpUrl(line)) problems.push(`invalid page URL ${JSON.stringify(line)} (absolute http(s) URL without spaces, quotes or backslashes expected)`);
            else if (seen.has(line)) problems.push(`duplicate page URL ${line}`);
            else {
                seen.add(line);
                urls.push(line);
            }
        }
        if (!urls.length && !problems.length) problems.push('the ```audit-pages block contains no URL');
    }

    if (problems.length) throw new AuditError('invalid audit parameters in the prompt', problems);
    return { report, date: REPORT_DATE_RE.exec(report)[1], urls };
}

export function reportDateFromPath(path) {
    const m = REPORT_DATE_RE.exec(basename(String(path)));
    if (!m || !isValidDate(m[1])) throw new AuditError(`the report file name ${basename(String(path))} must end with _YYYY-MM-DD.json`);
    return m[1];
}

// Returns null when the report does not exist yet.
export function readReport(path) {
    if (!existsSync(path)) return null;
    const report = readJson(path, 'report');
    if (!isPlainObject(report) || !Array.isArray(report.pages)) throw new AuditError(`${path} is not an audit report (no "pages" array)`);
    return report;
}

export function listRemaining(urls, report) {
    const audited = new Set((report ? report.pages : []).map(p => (isPlainObject(p) ? p.url : undefined)));
    return urls.filter(u => !audited.has(u));
}

// ---------------------------------------------------------------------------
// Validation shared by page submissions and reports
// ---------------------------------------------------------------------------

function checkEnvironment(env, where, problems) {
    if (!isPlainObject(env)) {
        problems.push(`${where} must be an object with ${ENVIRONMENT_KEYS.map(k => JSON.stringify(k)).join(' and ')}`);
        return;
    }
    checkKeys(env, ENVIRONMENT_KEYS, ENVIRONMENT_KEYS, where, problems);
    for (const k of ENVIRONMENT_KEYS) {
        if (env[k] !== undefined && !isNonEmptyString(env[k])) problems.push(`${where}.${k} must be a non-empty string`);
    }
}

function checkPageHeader(page, where, problems) {
    if (page.final_url !== undefined) {
        if (!isHttpUrl(page.final_url)) problems.push(`${where}.final_url must be an absolute http(s) URL`);
        else if (page.final_url === page.url) problems.push(`${where}.final_url must be omitted when it equals url`);
    }
    if (page.http_status !== undefined && !(Number.isInteger(page.http_status) && page.http_status >= 100 && page.http_status <= 599)) {
        problems.push(`${where}.http_status must be an integer between 100 and 599`);
    }
    if (page.error !== undefined) {
        if (!isNonEmptyString(page.error)) problems.push(`${where}.error must be a non-empty string`);
    } else if (page.http_status === undefined) {
        problems.push(`${where}: http_status is required for an audited page (or set "error" for a page that could not be audited)`);
    }
}

function checkStatus(c, ref, label, problems) {
    if (!STATUSES.includes(c.status)) {
        problems.push(`${label}: status must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(c.status)})`);
        return false;
    }
    if (ref.method === 'manual_required' && !MANUAL_STATUSES.has(c.status)) {
        problems.push(`${label}: status ${c.status} is not allowed for a manual_required criterion (use to_verify, or not_applicable when the subject of the criterion is absent)`);
    }
    return true;
}

function checkDetails(c, label, problems) {
    if (c.finding !== undefined && !isNonEmptyString(c.finding)) problems.push(`${label}: finding must be a non-empty string`);
    if (c.expected_correction !== undefined && !isNonEmptyString(c.expected_correction)) problems.push(`${label}: expected_correction must be a non-empty string`);
    if (c.affected_elements !== undefined && !(Array.isArray(c.affected_elements) && c.affected_elements.length && c.affected_elements.every(isNonEmptyString))) {
        problems.push(`${label}: affected_elements must be a non-empty array of CSS selectors`);
    }
    if (c.faulty_code !== undefined) {
        if (!isNonEmptyString(c.faulty_code)) problems.push(`${label}: faulty_code must be a non-empty string`);
        else if (c.faulty_code.length > FAULTY_CODE_MAX_LENGTH) problems.push(`${label}: faulty_code is ${c.faulty_code.length} characters long; keep a representative fragment of ${FAULTY_CODE_MAX_LENGTH} characters at most and mark cut parts with "…"`);
    }
    if (c.status === 'non_compliant') {
        for (const k of ['finding', 'expected_correction']) if (c[k] === undefined) problems.push(`${label}: ${k} is required for a non_compliant criterion`);
    } else if (c.status === 'to_verify') {
        if (c.finding === undefined) problems.push(`${label}: finding is required for a to_verify criterion (what a human must check, and why the agent could not conclude)`);
    } else {
        const forbidden = ['affected_elements', 'faulty_code', 'expected_correction'].filter(k => c[k] !== undefined);
        if (forbidden.length) problems.push(`${label}: ${forbidden.join(', ')} not allowed for a ${c.status} criterion (only finding is)`);
    }
}

// ---------------------------------------------------------------------------
// Page submission written by an agent (input of merge)
// ---------------------------------------------------------------------------

export function validateSubmission(submission, { url, catalog }) {
    const problems = [];
    if (!isPlainObject(submission)) return ['the page file must contain a JSON object with "environment" and "page"'];
    checkKeys(submission, SUBMISSION_KEYS, SUBMISSION_KEYS, 'page file', problems);
    if (submission.environment !== undefined) checkEnvironment(submission.environment, 'environment', problems);
    const page = submission.page;
    if (!isPlainObject(page)) {
        if (page !== undefined) problems.push('"page" must be an object');
        return problems;
    }
    checkKeys(page, SUBMISSION_PAGE_KEYS, ['url', 'criteria'], 'page', problems);
    if (page.url !== url) problems.push(`page.url must be exactly ${JSON.stringify(url)}, the target URL of the run (got ${JSON.stringify(page.url)})`);
    checkPageHeader(page, 'page', problems);
    if (!Array.isArray(page.criteria)) {
        if (page.criteria !== undefined) problems.push('page.criteria must be an array');
        return problems;
    }
    if (page.error !== undefined) {
        if (page.criteria.length) problems.push('page.criteria must be an empty array when page.error is set');
        return problems;
    }
    const seen = new Set();
    page.criteria.forEach((c, i) => {
        if (!isPlainObject(c)) {
            problems.push(`criteria[${i}] must be an object`);
            return;
        }
        const ref = typeof c.number === 'string' ? catalog.byNumber.get(c.number) : undefined;
        if (!ref) {
            problems.push(`criteria[${i}]: unknown criterion number ${JSON.stringify(c.number)} (numbers are strings such as "3.10")`);
            return;
        }
        const label = `criterion ${c.number}`;
        if (seen.has(c.number)) {
            problems.push(`${label}: listed more than once (use one entry per criterion, with every affected element in affected_elements)`);
            return;
        }
        seen.add(c.number);
        const unknown = Object.keys(c).filter(k => !SUBMISSION_CRITERION_KEYS.includes(k));
        if (unknown.length) {
            const hint = unknown.some(k => INJECTED_KEYS.includes(k)) ? ' (topic, title and method are added by the script from docs/rgaa-criteria.json: do not provide them)' : '';
            problems.push(`${label}: unknown ${unknown.length === 1 ? 'property' : 'properties'} ${unknown.map(k => JSON.stringify(k)).join(', ')}${hint}`);
        }
        if (checkStatus(c, ref, label, problems)) checkDetails(c, label, problems);
    });
    const missing = catalog.criteria.filter(c => !seen.has(c.number)).map(c => c.number);
    if (missing.length) problems.push(`missing ${missing.length} of the ${catalog.criteria.length} criteria: ${missing.join(', ')}`);
    return problems;
}

const trimmed = v => (typeof v === 'string' ? v.trim() : v);

function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
}

// Report entry built from a validated submission: canonical order, topic/title/method injected.
export function buildPageEntry(page, catalog, auditedAt) {
    const byNumber = new Map(page.criteria.map(c => [c.number, c]));
    const criteria = page.error !== undefined ? [] : catalog.criteria.map(ref => {
        const c = byNumber.get(ref.number);
        return compact({
            number: ref.number,
            topic: ref.topic,
            title: ref.title,
            status: c.status,
            method: ref.method,
            affected_elements: c.affected_elements && c.affected_elements.map(s => s.trim()),
            finding: trimmed(c.finding),
            faulty_code: trimmed(c.faulty_code),
            expected_correction: trimmed(c.expected_correction),
        });
    });
    return compact({
        url: page.url,
        final_url: page.final_url,
        audited_at: auditedAt,
        http_status: page.http_status,
        error: trimmed(page.error),
        criteria,
    });
}

// ---------------------------------------------------------------------------
// Report (output of merge)
// ---------------------------------------------------------------------------

export function validateReport(report, catalog) {
    const problems = [];
    if (!isPlainObject(report)) return ['the report must be a JSON object'];
    checkKeys(report, REPORT_KEYS, REPORT_KEYS, 'report', problems);
    if (report.date !== undefined && !isValidDate(report.date)) problems.push('report.date must be a valid YYYY-MM-DD date');
    if (report.reference_framework !== undefined && report.reference_framework !== catalog.referenceFramework) {
        problems.push(`report.reference_framework must be ${JSON.stringify(catalog.referenceFramework)}`);
    }
    if (report.environment !== undefined) checkEnvironment(report.environment, 'report.environment', problems);
    if (!Array.isArray(report.pages) || !report.pages.length) {
        if (report.pages !== undefined) problems.push('report.pages must be a non-empty array');
        return problems;
    }
    const urls = new Set();
    report.pages.forEach((page, i) => {
        const where = `pages[${i}]`;
        if (!isPlainObject(page)) {
            problems.push(`${where} must be an object`);
            return;
        }
        checkKeys(page, REPORT_PAGE_KEYS, ['url', 'audited_at', 'criteria'], where, problems);
        if (!isHttpUrl(page.url)) problems.push(`${where}.url must be an absolute http(s) URL`);
        else if (urls.has(page.url)) problems.push(`${where}.url ${page.url} appears more than once`);
        else urls.add(page.url);
        if (page.audited_at !== undefined && !(typeof page.audited_at === 'string' && ISO_UTC_RE.test(page.audited_at) && !Number.isNaN(Date.parse(page.audited_at)))) {
            problems.push(`${where}.audited_at must be an ISO 8601 UTC timestamp such as 2026-01-15T09:30:00Z`);
        }
        checkPageHeader(page, where, problems);
        if (!Array.isArray(page.criteria)) {
            if (page.criteria !== undefined) problems.push(`${where}.criteria must be an array`);
            return;
        }
        if (page.error !== undefined) {
            if (page.criteria.length) problems.push(`${where}.criteria must be empty when error is set`);
            return;
        }
        if (page.criteria.length !== catalog.criteria.length) {
            problems.push(`${where}.criteria must list the ${catalog.criteria.length} criteria in canonical order (found ${page.criteria.length})`);
            return;
        }
        page.criteria.forEach((c, k) => {
            const ref = catalog.criteria[k];
            const label = `${where} criterion ${ref.number}`;
            if (!isPlainObject(c)) {
                problems.push(`${label} must be an object`);
                return;
            }
            checkKeys(c, REPORT_CRITERION_KEYS, ['number', 'topic', 'title', 'status', 'method'], label, problems);
            for (const key of ['number', ...INJECTED_KEYS]) {
                if (c[key] !== undefined && c[key] !== ref[key]) problems.push(`${label}: ${key} must be ${JSON.stringify(ref[key])} (got ${JSON.stringify(c[key])})`);
            }
            if (checkStatus(c, ref, label, problems)) checkDetails(c, label, problems);
        });
    });
    return problems;
}

export function checkReportFileDate(report, path) {
    const date = reportDateFromPath(path);
    return isPlainObject(report) && report.date !== undefined && report.date !== date
        ? [`report.date ${JSON.stringify(report.date)} does not match the date in the file name (${date})`]
        : [];
}

export function writeJsonAtomic(path, data) {
    const dir = dirname(resolve(path));
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    try {
        renameSync(tmp, path);
    } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}

const isoSeconds = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Appends one validated page to the report, creating the report on the first merge.
export function mergePage({ reportPath, url, submission, catalog, now = new Date() }) {
    const date = reportDateFromPath(reportPath);
    const submissionProblems = validateSubmission(submission, { url, catalog });
    if (submissionProblems.length) throw new AuditError('the page file is invalid; fix it and run the merge command again', submissionProblems);

    const existing = readReport(reportPath);
    if (existing) {
        const reportProblems = [...validateReport(existing, catalog), ...checkReportFileDate(existing, reportPath)];
        if (reportProblems.length) throw new AuditError(`the existing report ${reportPath} is invalid; nothing was merged`, reportProblems);
        if (existing.pages.some(p => p.url === url)) {
            throw new AuditError(`${url} is already in ${reportPath}: a page is audited once per report (start a new report to audit it again)`);
        }
    }
    const base = existing || {
        date,
        reference_framework: catalog.referenceFramework,
        environment: { playwright_mcp: submission.environment.playwright_mcp.trim(), chromium: submission.environment.chromium.trim() },
        pages: [],
    };
    const page = buildPageEntry(submission.page, catalog, isoSeconds(now));
    const report = { ...base, pages: [...base.pages, page] };
    const finalProblems = validateReport(report, catalog);
    if (finalProblems.length) throw new AuditError('the merged report would be invalid; nothing was merged', finalProblems);
    writeJsonAtomic(reportPath, report);
    return { report, page, created: !existing };
}

export function countStatuses(page) {
    const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const c of page.criteria) counts[c.status]++;
    return counts;
}
