import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, utimes } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.ts';
import { PageTextIndex } from '../src/index-store.ts';
import { AuthService } from '../src/auth.ts';
import { AnnotationStore } from '../src/store.ts';
import { createApp } from '../src/server.ts';
import { HighlightService } from '../src/highlight/index.ts';
import { JevJudge } from '../src/highlight/jev-provider.ts';
import { LlmJudge } from '../src/highlight/llm-provider.ts';

const root = resolve('../meta/operation-record-check');
await mkdir(root, { recursive: true });
const dataDir = await mkdtemp(join(root, 'run-'));
const search = await readFile('../site/search/search_index.json');
const staticServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(search);
});
await new Promise<void>((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
const staticPort = (staticServer.address() as { port: number }).port;
const config = loadConfig({ DATA_DIR: dataDir, HOST: '127.0.0.1', DEV_AUTH_BYPASS: 'true',
  SEARCH_INDEX_URL: `http://127.0.0.1:${staticPort}/search/search_index.json` });
const index = new PageTextIndex(config.searchIndexUrl, config.indexRefreshMs);
await index.load();
const h = config.highlight;
const highlight = new HighlightService({ config, index, judges: {
  jev: new JevJudge({ apiKey: h.jevApiKey, baseUrl: h.jevBaseUrl, model: h.jevModel,
    timeoutMs: h.jevTimeoutMs, inputCostPerMtok: h.jevInputCostPerMtok }),
  llm: new LlmJudge({ apiKey: h.llmApiKey, model: h.llmModel, maxTokens: h.llmMaxTokens,
    timeoutMs: h.llmTimeoutMs, baseUrl: h.llmBaseUrl, mode: h.llmMode,
    inputCostPerMtok: h.llmInputCostPerMtok, outputCostPerMtok: h.llmOutputCostPerMtok }),
} });
let store = new AnnotationStore(dataDir);
await store.load();
let auth = new AuthService(config, store);
let server: Server;
let base: string;
async function start(permitTtlMs?: number): Promise<void> {
  ({ server } = createApp({ config, store, auth, index, highlight, permitTtlMs }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function stop(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function call(path: string, token?: string, method = 'GET', payload?: unknown, permit?: string) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(permit ? { 'X-Annotation-Permit': permit } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const alice = auth.issueSession({ githubId: 101, login: 'alice' });
const bob = auth.issueSession({ githubId: 202, login: 'bob' });
await store.flush();
await start();
const requestId = 'same-user-request-2026';
const url = `/api/annotation-requests/${requestId}`;
const payload = { requestId, page: '/ai/rag/', body: 'operation body', color: 'yellow',
  visibility: 'private', target: { scope: 'page', selectors: [] } };
async function permit(token: string, body: unknown = payload): Promise<string> {
  const response = await call('/api/annotation-permits', token, 'POST', body);
  assert.equal(response.status, 201);
  return response.body.permit as string;
}
try {
  assert.equal((await call(url, alice)).status, 404);
  assert.equal((await call(url)).status, 401);
  assert.equal((await call('/api/annotation-permits', undefined, 'POST', payload)).status, 401);
  assert.equal((await call('/api/annotations', alice, 'POST', payload)).status, 403);
  assert.equal(store.annotations.length, 0);
  const alicePermit = await permit(alice);
  assert.equal((await call('/api/annotations', bob, 'POST', payload, alicePermit)).status, 403);
  assert.equal((await call('/api/annotations', alice, 'POST',
    { ...payload, body: 'changed' }, alicePermit)).status, 403);
  const otherSession = auth.issueSession({ githubId: 101, login: 'alice' });
  assert.equal((await call('/api/annotations', otherSession, 'POST', payload, alicePermit)).status, 403);
  assert.equal(store.annotations.length, 0);
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    call('/api/annotations', alice, 'POST', payload, alicePermit)));
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 200, 200, 201]);
  const annotationId = results[0]!.body.annotation.id as string;
  assert(results.every((item) => item.body.annotation.id === annotationId));
  assert.equal(store.operations.length, 1);
  assert.equal((await call(url, bob)).status, 404);
  assert.equal((await call(url, alice)).body.operation.annotationId, annotationId);
  assert.equal((await call(url, alice)).body.operation.status, 'succeeded');
  assert.equal((await call(url, alice)).body.operation.deleted, false);
  const replyPath = `/api/annotations/${annotationId}/replies`;
  const reply = { body: 'reply body' };
  assert.equal((await call(replyPath, bob, 'POST', reply)).status, 404);
  assert.equal((await call(replyPath, alice, 'POST', reply)).status, 403);
  assert.equal((await call('/api/reply-permits', bob, 'POST',
    { annotationId, ...reply })).status, 404);
  const replyPermitResponse = await call('/api/reply-permits', alice, 'POST',
    { annotationId, ...reply });
  assert.equal(replyPermitResponse.status, 201);
  const replyPermit = replyPermitResponse.body.permit as string;
  assert.equal((await call(replyPath, otherSession, 'POST', reply, replyPermit)).status, 403);
  assert.equal((await call(replyPath, alice, 'POST', { body: 'tampered' }, replyPermit)).status, 403);
  assert.equal((await call(replyPath, alice, 'POST', reply, replyPermit)).status, 201);
  assert.equal((await call(replyPath, alice, 'POST', reply, replyPermit)).status, 403);
  assert.equal((await call(`/api/annotations/${annotationId}`, alice, 'PATCH',
    { replies: [{ body: 'bypass' }] })).status, 403);
  assert.equal((await call('/api/annotations', alice, 'POST',
    { ...payload, requestId: 'new-request-2026' }, alicePermit)).status, 403);
  const bobCreate = await call('/api/annotations', bob, 'POST', payload, await permit(bob));
  assert.equal(bobCreate.status, 201);
  assert.notEqual(bobCreate.body.annotation.id, annotationId);
  assert.equal((await call(url, bob)).body.operation.annotationId, bobCreate.body.annotation.id);
  assert.equal((await call('/api/annotations', alice, 'POST',
    { ...payload, body: 'changed' })).status, 409);
  assert.equal((await call(`/api/annotations/${annotationId}`, alice, 'PATCH',
    { body: 'edited', visibility: 'public' })).status, 200);
  const receipt = (await call(url, alice)).body.operation;
  assert.equal(receipt.visibility, 'private');
  assert.equal(receipt.page, '/ai/rag/');
  assert.equal(receipt.annotationId, annotationId);
  assert.equal(receipt.deleted, false);
  assert(!JSON.stringify(receipt).includes('operation body'));
  assert.equal((await call(`/api/annotations/${annotationId}`, alice, 'DELETE')).status, 200);
  assert.equal((await call(url, alice)).body.operation.deleted, true);
  assert.equal((await call('/api/annotations', alice, 'POST', payload)).body.operation.annotationId,
    annotationId);
  assert.equal(store.annotations.some((item) => item.id === annotationId), false);
  await stop();
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await utimes(store.path, old, old);
  assert((await stat(store.path)).mtimeMs < Date.now() - 30 * 24 * 60 * 60 * 1000);
  store = new AnnotationStore(dataDir);
  await store.load();
  auth = new AuthService(config, store);
  await start();
  assert.equal((await call(url, alice)).body.operation.deleted, true);
  assert.equal((await call(url, bob)).body.operation.annotationId, bobCreate.body.annotation.id);
  assert.equal((await call('/api/annotations', alice, 'POST', payload)).body.operation.annotationId,
    annotationId);
  assert.equal(store.annotations.filter((item) => item.requestId === requestId).length, 1);
  assert.equal((await call('/api/annotation-requests/bad', alice)).status, 400);
  await stop();
  await start(50);
  const expiring = { ...payload, requestId: 'expired-request-2026' };
  const expiredPermit = await permit(alice, expiring);
  await delay(100);
  assert.equal((await call('/api/annotations', alice, 'POST', expiring, expiredPermit)).status, 403);
  assert.equal((await call('/api/annotations', alice, 'POST', expiring,
    await permit(alice, expiring))).status, 201);
  console.log('operation-record-check: HTTP / concurrency / restart / edit / delete / retention passed');
} finally {
  await stop();
  index.stop();
  await new Promise<void>((resolve) => staticServer.close(() => resolve()));
}
