// Live smoke test: runs the Actor locally with a given input and prints a summary of what it saved.
// Usage (from the Actor folder): node test/run_local.mjs @file.json [rows to print]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] ?? '{"domains":["google.com","wikipedia.org"]}';
const input = JSON.parse(arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg);

const storage = path.join(root, 'storage');
fs.rmSync(storage, { recursive: true, force: true });
const kv = path.join(storage, 'key_value_stores', 'default');
fs.mkdirSync(kv, { recursive: true });
fs.writeFileSync(path.join(kv, 'INPUT.json'), JSON.stringify(input));

const t0 = Date.now();
const run = spawnSync(process.execPath, ['src/main.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, APIFY_LOCAL_STORAGE_DIR: storage } });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

const dsDir = path.join(storage, 'datasets', 'default');
const files = fs.existsSync(dsDir) ? fs.readdirSync(dsDir).filter((f) => /^\d+\.json$/.test(f)).sort() : [];
const items = files.map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8')));
const count = (fn) => items.filter(fn).length;
const perStatus = {};
for (const it of items) perStatus[it.status] = (perStatus[it.status] ?? 0) + 1;
console.log('\n=== exit code', run.status, '| seconds', seconds, '| items', items.length, '| per status', JSON.stringify(perStatus),
    '| distinct inputs', new Set(items.map((i) => i.input)).size,
    '| registered with createdAt', count((i) => i.registered && i.createdAt), '| with expiresAt', count((i) => i.expiresAt),
    '| with registrar', count((i) => i.registrar), '| with nameservers', count((i) => i.nameservers.length > 0),
    '| contains @', count((i) => JSON.stringify(i).includes('@')));
const summaryFile = path.join(kv, 'SUMMARY.json');
if (fs.existsSync(summaryFile)) console.log('SUMMARY', JSON.stringify(JSON.parse(fs.readFileSync(summaryFile, 'utf8'))));
const rows = Number(process.argv[3] ?? 3);
for (const it of items.slice(0, rows)) console.log(JSON.stringify(it));
if (rows > 0) console.table(items.map((i) => ({ input: i.input.slice(0, 34), domain: i.domain, status: i.status, created: i.createdAt?.slice(0, 10), expires: i.expiresAt?.slice(0, 10), registrar: i.registrar?.slice(0, 28), ns: i.nameservers.length })));
fs.writeFileSync(path.join(storage, 'items.json'), JSON.stringify(items, null, 1));
process.exit(run.status ?? 1);
