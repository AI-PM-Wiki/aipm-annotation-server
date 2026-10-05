import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const manifest = JSON.parse(await readFile(new URL('./coverage-109.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = execFileSync('git', ['show', `${manifest.baseline}:src/unit-check.ts`], { encoding: 'utf8', cwd: root });
const integrated = execFileSync('git', ['show', `${manifest.integrationBaseline}:src/unit-check.ts`], { encoding: 'utf8', cwd: root });

function inventory(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tests = [];
  function visit(node) {
    if (ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'test') ||
         (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'test')) &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      tests.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
                   name: node.arguments[0].text });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return tests;
}

const old = inventory(baseline, 'baseline-unit-check.ts');
const all = inventory(integrated, 'integrated-unit-check.ts');
assert.equal(old.length, 109);
assert.equal(all.length, 112);
assert.equal(manifest.items.length, all.length);
assert.deepEqual(manifest.items.map(item => item.line), all.map(item => item.line));
for (const original of old) assert.equal(all.filter(item => item.name === original.name).length, 1);
const namesByFile = new Map();
for (const [id, evidence] of Object.entries(manifest.evidence)) {
  const source = await readFile(resolve(root, evidence.file), 'utf8');
  if (evidence.test) {
    if (!namesByFile.has(evidence.file)) namesByFile.set(evidence.file, inventory(source, evidence.file).map(item => item.name));
    assert(namesByFile.get(evidence.file).includes(evidence.test), `missing evidence test: ${id}`);
  }
}
const counts = { covered: 0, missing_configuration: 0, missing_check: 0 };
const originalCounts = { ...counts };
const records = manifest.items.map((item, i) => {
  assert(Object.hasOwn(counts, item.status), `invalid coverage status: ${item.line}`);
  if (item.status === 'covered') assert(item.evidence.length > 0);
  if (item.status === 'missing_check') assert(item.remaining);
  if (item.status === 'missing_configuration') {
    assert(item.configuration);
    assert.equal(item.acceptance, 'not_run');
  }
  for (const id of item.evidence) assert(Object.hasOwn(manifest.evidence, id), `unknown evidence: ${id}`);
  counts[item.status]++;
  const original = old.find(entry => entry.name === all[i].name);
  if (original) originalCounts[item.status]++;
  return { id: i + 1, ...item, baselineLine: original?.line ?? null,
    group: original ? 'baseline109' : 'integration3',
    originalNameSha256: createHash('sha256').update(all[i].name).digest('hex'),
    evidence: item.evidence.map(id => ({ id, ...manifest.evidence[id] })) };
});
console.log(JSON.stringify({ baseline: manifest.baseline, integrationBaseline: manifest.integrationBaseline,
  baselineSourceSha256: createHash('sha256').update(baseline).digest('hex'),
  integratedSourceSha256: createHash('sha256').update(integrated).digest('hex'),
  originalCount: old.length, supplementalCount: all.length - old.length, counts, originalCounts, records }, null, 2));
