// Keeps the copies of the contract in sync with docs/rgaa-criteria.json: the audit grid of the prompt,
// the JSON Schema, the MCP configuration referenced by the prompt and the loop, and the paths the loop gives the agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODS, STATUSES, loadCatalog } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(ROOT, file), 'utf8');
const catalog = loadCatalog();

test('the audit grid of the prompt lists every criterion once, with its canonical method', () => {
    const rows = [...read('audit-prompt.example.md').matchAll(/^\|\s*(\d+\.\d+)\s*\|\s*`?([a-z_]+)`?\s*\|/gm)].map(m => ({ number: m[1], method: m[2] }));
    assert.deepEqual(rows, catalog.criteria.map(c => ({ number: c.number, method: c.method })));
});

test('the JSON Schema enumerates the canonical numbers, topics, statuses and methods', () => {
    const schema = JSON.parse(read('docs/audit.schema.json'));
    const props = schema.$defs.criterion.properties;
    assert.deepEqual(props.number.enum, catalog.criteria.map(c => c.number));
    assert.deepEqual(props.topic.enum, [...new Set(catalog.criteria.map(c => c.topic))]);
    assert.deepEqual(props.status.enum, [...STATUSES]);
    assert.deepEqual(props.method.enum, [...METHODS]);
    assert.equal(schema.properties.reference_framework.const, catalog.referenceFramework);
    assert.equal(schema.$defs.page.else.properties.criteria.minItems, catalog.criteria.length);
    assert.equal(schema.$defs.page.else.properties.criteria.maxItems, catalog.criteria.length);
});

test('the loop runs the agents in a git-ignored directory one level below the root, with matching paths', () => {
    const loop = read('audit-loop.ps1');
    const value = name => new RegExp(`^\\$${name}\\s*=\\s*['"]([^'"]+)['"]`, 'm').exec(loop)?.[1];
    const workDir = value('WorkDir');
    // Playwright writes every file an agent names into this directory: it must never reach git
    assert.match(workDir, /^[^/\\]+$/, 'the run parameters reach the root with "../"');
    assert.ok(read('.gitignore').split(/\r?\n/).includes(`${workDir}/`), `${workDir}/ missing from .gitignore`);
    assert.equal(value('AgentReportScript'), '../$ReportScript');
    assert.match(loop, /'--allowedTools',.*"Edit\(\.\/\$PageFile\)", "Bash\(node \$AgentReportScript merge \*\)"/);
    assert.match(loop, /``node \$AgentReportScript merge --report '\$agentReport' --url '\$Url' --page \$PageFile``/);
    assert.match(loop, /Invoke-Native -FilePath 'claude' .*-WorkingDirectory \$WorkDir/);
});

test('the MCP configuration pins @playwright/mcp and runs a headless, isolated Chromium', () => {
    const server = JSON.parse(read('audit.mcp.json')).mcpServers.playwright;
    const pkg = server.args.find(a => a.startsWith('@playwright/mcp@'));
    assert.match(pkg, /^@playwright\/mcp@\d+\.\d+\.\d+$/);
    for (const flag of ['--headless', '--isolated']) assert.ok(server.args.includes(flag), `missing ${flag}`);
    assert.equal(server.args[server.args.indexOf('--browser') + 1], 'chromium');
});
