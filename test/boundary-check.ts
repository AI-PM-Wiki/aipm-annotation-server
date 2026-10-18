import assert from 'node:assert/strict';
import { DailyBudget, DailyCounter } from '../src/budget.ts';
import { JevJudge } from '../src/highlight/jev-provider.ts';
import { JudgeError } from '../src/highlight/judge.ts';
import { LlmJudge } from '../src/highlight/llm-provider.ts';

let now = new Date('2026-10-05T23:59:59.999Z');
const clock = () => now;

const request = {
  page: '/ai/rag/',
  title: 'RAG',
  palette: [{ id: 'yellow', label: '重点', when: '值得记住的重点内容' }],
  chunk: { index: 0, blocks: [{ id: 'b1', text: '这是一段足够长的正文内容，用于覆盖 provider 请求边界。' }] },
  totalChunks: 1,
};

function assertCode(error: unknown, code: string): error is JudgeError {
  return error instanceof JudgeError && error.code === code;
}

const budget = new DailyBudget(1, clock);
assert.equal(budget.tryReserve(0.6), true);
budget.settle(0.6, 0.6);
assert.equal(budget.spentUsd, 0.6);
assert.equal(budget.remainingUsd, 0.4);
now = new Date('2026-10-06T00:00:00.000Z');
assert.equal(budget.spentUsd, 0, '预算在 UTC 午夜读取时重置');
assert.equal(budget.reservedUsd, 0);
assert.equal(budget.remainingUsd, 1);
assert.equal(budget.tryReserve(1), true);
budget.settle(1, 1);
assert.equal(budget.exhausted, true);

now = new Date('2026-10-05T23:59:59.999Z');
const counter = new DailyCounter(1, clock);
assert.equal(counter.tryAcquire(), true);
assert.equal(counter.tryAcquire(), false);
assert.equal(counter.usedCount, 1);
now = new Date('2026-10-06T00:00:00.000Z');
assert.equal(counter.usedCount, 0, '调用次数在 UTC 午夜读取时重置');
assert.equal(counter.tryAcquire(), true);
assert.equal(counter.usedCount, 1);

const jevRateLimited = new JevJudge({
  apiKey: 'test-key',
  baseUrl: 'https://provider.test',
  model: 'test-model',
  timeoutMs: 1000,
  inputCostPerMtok: 1,
  fetchImpl: async () => new Response(JSON.stringify({ error: 'rate' }), {
    status: 429,
    headers: { 'retry-after': '7' },
  }),
});
await assert.rejects(() => jevRateLimited.judge(request), (error: unknown) => {
  return assertCode(error, 'rate_limited') && error.retryAfterSec === 7;
});

const jevMalformed = new JevJudge({
  apiKey: 'test-key',
  baseUrl: 'https://provider.test',
  model: 'test-model',
  timeoutMs: 1000,
  inputCostPerMtok: 1,
  fetchImpl: async () => new Response('not-json', { status: 200 }),
});
await assert.rejects(() => jevMalformed.judge(request), (error: unknown) => assertCode(error, 'shape'));

const llmRateLimited = new LlmJudge({
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 128,
  timeoutMs: 1000,
  inputCostPerMtok: 1,
  outputCostPerMtok: 1,
  caller: async () => {
    throw Object.assign(new Error('rate'), { status: 429 });
  },
});
await assert.rejects(() => llmRateLimited.judge(request), (error: unknown) => {
  return assertCode(error, 'rate_limited') && error.retryAfterSec === 60;
});

let malformedCalls = 0;
const llmMalformed = new LlmJudge({
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 128,
  timeoutMs: 1000,
  inputCostPerMtok: 1,
  outputCostPerMtok: 1,
  caller: async () => {
    malformedCalls++;
    return { parsed: { results: [] }, usage: { inputTokens: 3, outputTokens: 2 }, model: 'test-model' };
  },
});
await assert.rejects(() => llmMalformed.judge(request), (error: unknown) => assertCode(error, 'shape'));
assert.equal(malformedCalls, 2, '格式错误分支只按 provider 规则重试一次');

console.log(JSON.stringify({
  status: 'passed',
  checks: {
    utcBudget: 'passed',
    utcCounter: 'passed',
    jevRateLimited: 'passed',
    jevMalformed: 'passed',
    llmRateLimited: 'passed',
    llmMalformedRetry: 'passed',
  },
}, null, 2));
