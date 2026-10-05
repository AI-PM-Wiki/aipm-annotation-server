import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from './config.ts';
import { PageTextIndex, normalizeIndexText } from './index-store.ts';
import { HighlightService } from './highlight/index.ts';
import { JevJudge } from './highlight/jev-provider.ts';
import { LlmJudge } from './highlight/llm-provider.ts';

const group = process.argv[2] ?? 'all';
assert(['all', 'llm', 'jev'].includes(group), 'expected all, llm or jev');
const requirements = {
  llm: ['AIPM_REAL_MODEL_API_KEY', 'AIPM_REAL_MODEL_BASE_URL', 'AIPM_REAL_MODEL_NAME'],
  jev: ['AIPM_REAL_JEV_API_KEY', 'AIPM_REAL_JEV_BASE_URL', 'AIPM_REAL_JEV_MODEL'],
};
let pending = false;
for (const provider of ['llm', 'jev'] as const) {
  if (group !== 'all' && group !== provider) continue;
  const missing = requirements[provider].filter(name => !process.env[name]);
  if (missing.length) {
    console.log(JSON.stringify({ provider, status: 'not_run', missing,
      checks: ['provider response', 'usage cost', 'partial coverage', 'cache reuse', 'cache reload', 'refresh'] }));
    pending = true;
    continue;
  }
  const baseUrl = new URL(process.env[requirements[provider][1]!]!);
  assert.equal(baseUrl.protocol, 'https:');
  assert.equal(baseUrl.username, '');
  assert.equal(baseUrl.password, '');
  assert.equal(baseUrl.search, '');
  assert.equal(baseUrl.hash, '');
  await test(`authorized ${provider} provider and cache`, async t => {
    const root = resolve('../meta/model-check');
    await mkdir(root, { recursive: true });
    const data = await mkdtemp(join(root, `${provider}-`));
    const search = await readFile('../site/search/search_index.json');
    const staticServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(search);
    });
    await new Promise<void>(resolve => staticServer.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await new Promise<void>((resolve, reject) => staticServer.close(error => error ? reject(error) : resolve()));
    });
    const config = loadConfig({ HOST: '127.0.0.1', DEV_AUTH_BYPASS: 'true', DATA_DIR: data,
      SEARCH_INDEX_URL: `http://127.0.0.1:${(staticServer.address() as { port: number }).port}/search/search_index.json`,
      HIGHLIGHT_JUDGE_PRIMARY: provider, HIGHLIGHT_JUDGE_FALLBACK: 'none',
      HIGHLIGHT_RATE_LIMIT_MAX: '100', HIGHLIGHT_CACHE_TTL_MS: '600000',
      ...(provider === 'llm' ? {
        ANTHROPIC_API_KEY: process.env.AIPM_REAL_MODEL_API_KEY!,
        ANTHROPIC_BASE_URL: baseUrl.href, HIGHLIGHT_MODEL: process.env.AIPM_REAL_MODEL_NAME!,
      } : {
        TYPESAFE_API_KEY: process.env.AIPM_REAL_JEV_API_KEY!,
        TYPESAFE_BASE_URL: baseUrl.href, JEV_MODEL: process.env.AIPM_REAL_JEV_MODEL!,
      }),
    });
    const index = new PageTextIndex(config.searchIndexUrl, config.indexRefreshMs);
    await index.load();
    t.after(() => index.stop());
    const h = config.highlight;
    const jev = new JevJudge({ apiKey: h.jevApiKey, baseUrl: h.jevBaseUrl, model: h.jevModel,
      timeoutMs: h.jevTimeoutMs, inputCostPerMtok: h.jevInputCostPerMtok });
    const llm = new LlmJudge({ apiKey: h.llmApiKey, model: h.llmModel, maxTokens: h.llmMaxTokens,
      timeoutMs: h.llmTimeoutMs, baseUrl: h.llmBaseUrl, mode: h.llmMode,
      inputCostPerMtok: h.llmInputCostPerMtok, outputCostPerMtok: h.llmOutputCostPerMtok });
    const page = '/ai/rag/';
    const source = normalizeIndexText(index.pageText(page));
    assert(source.length > 400);
    const blocks = [{ id: 'b1', text: source.slice(0, 200) }, { id: 'b2', text: source.slice(200, 400) }];
    const palette = [{ id: 'yellow', label: '定义', when: '定义与术语' }];
    const outcome = await (provider === 'llm' ? llm : jev).judge({ page, title: 'RAG', palette,
      chunk: { index: 0, blocks }, totalChunks: 1 });
    assert(outcome.suggestions.length > 0);
    assert((outcome.usage?.inputTokens ?? 0) > 0);
    const usage = outcome.usage!;
    assert.equal(usage.costUsd, ((usage.inputTokens ?? 0) * (provider === 'llm'
      ? h.llmInputCostPerMtok : h.jevInputCostPerMtok) +
      (provider === 'llm' ? (usage.outputTokens ?? 0) * h.llmOutputCostPerMtok : 0)) / 1_000_000);
    assert(outcome.suggestions.every(item => blocks.some(block => block.id === item.id)));
    assert(outcome.suggestions.every(item => item.worth >= 0 && item.worth <= 1));
    assert(outcome.suggestions.every(item => item.source === provider));
    assert.equal(typeof outcome.model, 'string');
    assert(outcome.model!.length > 0);
    if (provider === 'llm') assert(outcome.suggestions.every(item => item.confidence === null));
    await writeFile(join(data, 'provider-outcome.json'), JSON.stringify(outcome, null, 2));
    const cachePath = join(data, 'highlight-cache.json');
    const service = new HighlightService({ config, index, judges: { jev, llm }, cachePath });
    const request = { page, title: 'RAG', palette, blocks, judge: 'auto' as const };
    const partial = await service.suggest({ ...request, blocks: [blocks[0]!] }, 'model-review');
    assert(partial.ok);
    assert.equal(partial.body.cached, undefined);
    const full = await service.suggest(request, 'model-review');
    assert(full.ok);
    assert.equal(full.body.cached, undefined);
    assert.equal(full.body.judge, provider);
    assert.equal(typeof full.body.model, 'string');
    assert(full.body.model!.length > 0);
    assert(full.body.suggestions.every(item => item.source === provider));
    const calls = provider === 'llm' ? service.llmCalls : service.jevCalls;
    const previousCalls = calls.usedCount;
    const previousSpent = service.budget.spentUsd;
    const repeated = await service.suggest(request, 'model-review');
    assert(repeated.ok);
    assert.equal(repeated.body.cached, true);
    assert.deepEqual(repeated.body.suggestions, full.body.suggestions);
    assert.equal(calls.usedCount, previousCalls);
    assert.equal(service.budget.spentUsd, previousSpent);
    await service.flushCache();
    const restarted = new HighlightService({ config, index, judges: { jev, llm }, cachePath });
    assert.equal((await restarted.loadCache()).loaded, 1);
    const restored = await restarted.suggest(request, 'model-review');
    assert(restored.ok);
    assert.equal(restored.body.cached, true);
    assert.deepEqual(restored.body.suggestions, full.body.suggestions);
    assert.equal(restarted.jevCalls.usedCount, 0);
    assert.equal(restarted.llmCalls.usedCount, 0);
    assert.equal(restarted.budget.spentUsd, 0);
    const refreshed = await restarted.suggest({ ...request, refresh: true }, 'model-review');
    assert(refreshed.ok);
    assert.equal(refreshed.body.cached, undefined);
    await restarted.flushCache();
    const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as {
      entries: Array<{ key: string; expiresAt: number; coverage?: string[]; body: unknown }>;
    };
    for (const entry of persisted.entries) delete entry.coverage;
    await writeFile(cachePath, JSON.stringify(persisted));
    const legacy = new HighlightService({ config, index, judges: { jev, llm }, cachePath });
    assert.equal((await legacy.loadCache()).loaded, 1);
    const recalculated = await legacy.suggest(request, 'model-review');
    assert(recalculated.ok);
    assert.equal(recalculated.body.cached, undefined);
    assert((provider === 'llm' ? legacy.llmCalls : legacy.jevCalls).usedCount > 0);
    await legacy.flushCache();
    await writeFile(cachePath, '{ invalid cache JSON');
    const corrupted = new HighlightService({ config, index, judges: { jev, llm }, cachePath });
    assert.deepEqual(await corrupted.loadCache(), { loaded: 0, dropped: 0 });
    const fresh = await corrupted.suggest({ ...request, blocks: [blocks[0]!,
      { id: 'footer', text: '在 GitHub 上编辑此页，贡献者信息与版权说明。' }] }, 'model-review');
    assert(fresh.ok);
    assert.equal(fresh.body.cached, undefined);
    assert(fresh.body.degraded.some(item => item.id === 'footer' && item.reason === 'not_in_page'));
    assert(fresh.body.suggestions.every(item => item.id === blocks[0]!.id));
    assert((provider === 'llm' ? corrupted.llmCalls : corrupted.jevCalls).usedCount > 0);
    await corrupted.flushCache();
  });
}
if (pending) process.exitCode = 1;
