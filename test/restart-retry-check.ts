import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AuthService } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { HighlightService } from '../src/highlight/index.ts';
import { JevJudge } from '../src/highlight/jev-provider.ts';
import { LlmJudge } from '../src/highlight/llm-provider.ts';
import { PageTextIndex } from '../src/index-store.ts';
import { createApp } from '../src/server.ts';
import { AnnotationStore } from '../src/store.ts';

await test('failed storage write retries the same request after a process restart', async t => {
  const root = resolve('../meta/restart-retry-check');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'run-'));
  const search = await readFile('../site/search/search_index.json');
  const staticServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(search);
  });
  await new Promise<void>(resolve => staticServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => staticServer.close(error => error ? reject(error) : resolve()));
  });
  const config = loadConfig({ HOST: '127.0.0.1', DEV_AUTH_BYPASS: 'true', DATA_DIR: directory,
    SEARCH_INDEX_URL: `http://127.0.0.1:${(staticServer.address() as { port: number }).port}/search/search_index.json` });
  const store = new AnnotationStore(directory);
  await store.load();
  const index = new PageTextIndex(config.searchIndexUrl, config.indexRefreshMs);
  await index.load();
  t.after(() => index.stop());
  const auth = new AuthService(config, store);
  const h = config.highlight;
  const highlight = new HighlightService({ config, index, judges: {
    jev: new JevJudge({ apiKey: h.jevApiKey, baseUrl: h.jevBaseUrl, model: h.jevModel,
      timeoutMs: h.jevTimeoutMs, inputCostPerMtok: h.jevInputCostPerMtok }),
    llm: new LlmJudge({ apiKey: h.llmApiKey, model: h.llmModel, maxTokens: h.llmMaxTokens,
      timeoutMs: h.llmTimeoutMs, baseUrl: h.llmBaseUrl, mode: h.llmMode,
      inputCostPerMtok: h.llmInputCostPerMtok, outputCostPerMtok: h.llmOutputCostPerMtok }),
  } });
  const { server } = createApp({ config, store, auth, index, highlight });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = auth.issueSession({ githubId: 42, login: 'restart-review' });
  await store.flush();
  const payload = { requestId: randomUUID(), page: '/ai/rag/', body: 'restart retry',
    color: 'yellow', visibility: 'private', target: { selectors: [], scope: 'page' } };
  async function call(path: string, method = 'GET', body?: unknown, permit?: string) {
    const response = await fetch(base + path, { method, headers: {
      Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(permit ? { 'X-Annotation-Permit': permit } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  const beforeFailure = await call('/api/annotation-permits', 'POST', payload);
  assert.equal(beforeFailure.status, 201);
  await mkdir(`${store.path}.tmp`);
  const failed = await call('/api/annotations', 'POST', payload, beforeFailure.body.permit);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'storage_failed');
  assert.equal(store.annotations.length, 0);
  assert.equal(store.operations.length, 0);
  const diskBefore = new AnnotationStore(directory);
  await diskBefore.load();
  assert.equal(diskBefore.annotations.length, 0);
  assert.equal(diskBefore.operations.length, 0);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rmdir(`${store.path}.tmp`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: '127.0.0.1',
      PORT: new URL(base).port, DATA_DIR: directory, SEARCH_INDEX_URL: config.searchIndexUrl,
      DEV_AUTH_BYPASS: 'true', TMPDIR: resolve('../meta/runtime') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await writeFile(join(directory, 'restart.log'), output.join(''));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('restart readiness timeout')), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`restart exited ${code}`)); });
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(base)) { clearTimeout(timer); resolve(); }
    });
  });
  const missing = await call(`/api/annotation-requests/${payload.requestId}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');
  const mineBefore = await call('/api/annotations?page=/ai/rag/&scope=mine');
  assert.equal(mineBefore.status, 200);
  assert.deepEqual(mineBefore.body.annotations, []);
  const noPermit = await call('/api/annotations', 'POST', payload);
  assert.equal(noPermit.status, 403);
  assert.equal(noPermit.body.error, 'confirmation_required');
  const retryPermit = await call('/api/annotation-permits', 'POST', payload);
  assert.equal(retryPermit.status, 201);
  const retried = await call('/api/annotations', 'POST', payload, retryPermit.body.permit);
  assert.equal(retried.status, 201);
  assert.equal(retried.body.annotation.visibility, payload.visibility);
  assert.equal(retried.body.annotation.body, payload.body);
  assert.equal(retried.body.annotation.author.githubId, 42);
  assert(!('requestId' in retried.body.annotation));
  const repeated = await call('/api/annotations', 'POST', payload, retryPermit.body.permit);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.annotation.id, retried.body.annotation.id);
  assert(!('requestId' in repeated.body.annotation));
  const receipt = await call(`/api/annotation-requests/${payload.requestId}`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.operation.status, 'succeeded');
  assert.equal(receipt.body.operation.annotationId, retried.body.annotation.id);
  const finalDisk = new AnnotationStore(directory);
  await finalDisk.load();
  assert.equal(finalDisk.annotations.length, 1);
  assert.equal(finalDisk.operations.length, 1);
  assert.equal(finalDisk.annotations[0]!.requestId, payload.requestId);
  assert.equal(finalDisk.operations[0]!.requestId, payload.requestId);
  assert.equal(finalDisk.operations[0]!.annotationId, finalDisk.annotations[0]!.id);
  const result = { requestId: payload.requestId, initialStatus: failed.status,
    restartedReceiptStatus: missing.status, missingPermitStatus: noPermit.status,
    retryStatus: retried.status, repeatedStatus: repeated.status,
    annotationCount: finalDisk.annotations.length, operationCount: finalDisk.operations.length };
  console.log(JSON.stringify(result));
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
});
