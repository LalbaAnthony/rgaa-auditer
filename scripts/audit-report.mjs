#!/usr/bin/env node
// Command-line entry point of the shared audit report (see docs/audit-format.md).
//
//   node scripts/audit-report.mjs remaining --prompt <audit-prompt.md>
//       Prints {"report", "total", "remaining"} as JSON: the report path written in the prompt and the
//       page URLs of the prompt that are not in the report yet, in prompt order. Used by audit-loop.ps1.
//   node scripts/audit-report.mjs merge --report <report.json> --url <url> --page <page.json>
//       Validates one page submission and appends it to the report (created by the first merge).
//       Used by the audit agents.
//   node scripts/audit-report.mjs validate --report <report.json>
//       Validates a whole report against the contract.
//
// Exit codes: 0 success, 1 invalid input or report, 2 usage error.

import {
    AuditError, checkReportFileDate, countStatuses, listRemaining, loadCatalog, mergePage, parsePrompt,
    readJson, readReport, validateReport,
} from './report.mjs';
import { readFileSync } from 'node:fs';

const MAX_PROBLEMS_SHOWN = 60;

const COMMANDS = {
    remaining: ['prompt'],
    merge: ['report', 'url', 'page'],
    validate: ['report'],
};

const USAGE = `Usage:
  node scripts/audit-report.mjs remaining --prompt <audit-prompt.md>
  node scripts/audit-report.mjs merge --report <report.json> --url <url> --page <page.json>
  node scripts/audit-report.mjs validate --report <report.json>`;

class UsageError extends Error { }

function parseOptions(command, args) {
    const names = COMMANDS[command];
    if (!names) throw new UsageError(command ? `unknown command ${JSON.stringify(command)}` : 'missing command');
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        const flag = args[i];
        const name = flag.startsWith('--') ? flag.slice(2) : '';
        if (!names.includes(name)) throw new UsageError(`unknown option ${JSON.stringify(flag)} for ${command}`);
        if (i + 1 >= args.length) throw new UsageError(`missing value for ${flag}`);
        options[name] = args[i + 1];
    }
    const missing = names.filter(n => options[n] === undefined);
    if (missing.length) throw new UsageError(`${command} requires ${missing.map(n => '--' + n).join(', ')}`);
    return options;
}

function printProblems(message, problems) {
    console.error(`Error: ${message}`);
    problems.slice(0, MAX_PROBLEMS_SHOWN).forEach(p => console.error(`  - ${p}`));
    if (problems.length > MAX_PROBLEMS_SHOWN) console.error(`  ... and ${problems.length - MAX_PROBLEMS_SHOWN} more`);
}

function run(command, options) {
    if (command === 'remaining') {
        const prompt = parsePrompt(readFileSync(options.prompt, 'utf8'));
        const report = readReport(prompt.report);
        console.log(JSON.stringify({ report: prompt.report, total: prompt.urls.length, remaining: listRemaining(prompt.urls, report) }));
        return 0;
    }
    const catalog = loadCatalog();
    if (command === 'merge') {
        const submission = readJson(options.page, 'page file');
        const { report, page, created } = mergePage({ reportPath: options.report, url: options.url, submission, catalog });
        const where = `${options.report} (page ${report.pages.length}${created ? ', new report' : ''})`;
        if (page.error !== undefined) {
            console.log(`Merged ${page.url} into ${where} as not audited: ${page.error}`);
        } else {
            const counts = countStatuses(page);
            console.log(`Merged ${page.url} into ${where}: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ')}.`);
        }
        return 0;
    }
    const report = readReport(options.report);
    if (!report) throw new AuditError(`${options.report} does not exist`);
    const problems = [...validateReport(report, catalog), ...checkReportFileDate(report, options.report)];
    if (problems.length) {
        printProblems(`${options.report} is invalid`, problems);
        return 1;
    }
    const notAudited = report.pages.filter(p => p.error !== undefined).length;
    console.log(`${options.report} is valid: ${report.pages.length} page(s)${notAudited ? `, ${notAudited} not audited` : ''}.`);
    return 0;
}

function main(argv) {
    const [command, ...args] = argv;
    try {
        return run(command, parseOptions(command, args));
    } catch (e) {
        if (e instanceof UsageError) {
            console.error(`Error: ${e.message}\n\n${USAGE}`);
            return 2;
        }
        if (e instanceof AuditError) {
            printProblems(e.message, e.problems);
            return 1;
        }
        if (e && e.code === 'ENOENT') {
            console.error(`Error: ${e.message}`);
            return 1;
        }
        throw e;
    }
}

process.exitCode = main(process.argv.slice(2));
