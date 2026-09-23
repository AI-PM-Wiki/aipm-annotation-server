import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { AuthService } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { HighlightService } from "../src/highlight/index.ts";
import { JevJudge } from "../src/highlight/jev-provider.ts";
import { LlmJudge } from "../src/highlight/llm-provider.ts";
import { PageTextIndex } from "../src/index-store.ts";
import { createApp } from "../src/server.ts";
import { AnnotationStore } from "../src/store.ts";

const root = resolve("../meta/durability-check");
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, "run-"));
const search = await readFile("../site/search/search_index.json");
const staticServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(search);
});
await new Promise<void>((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
const staticPort = (staticServer.address() as { port: number }).port;
const config = loadConfig({ DATA_DIR: directory, HOST: "127.0.0.1", DEV_AUTH_BYPASS: "true",
  SEARCH_INDEX_URL: `http://127.0.0.1:${staticPort}/search/search_index.json` });
const store = new AnnotationStore(directory);
await store.load();
const index = new PageTextIndex(config.searchIndexUrl, config.indexRefreshMs);
await index.load();
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
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let watcher;
try {
  const token = auth.issueSession({ githubId: 1, login: "review-one" });
  await store.flush();
  let injected = false;
  watcher = watch(store.path, (event) => {
    if (event === "rename" && !injected) {
      if (existsSync(`${store.path}.tmp`)) rmSync(`${store.path}.tmp`);
      mkdirSync(`${store.path}.tmp`);
      injected = true;
    }
  });
  const pending = fetch(`${base}/api/annotations`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "review-request-partial-flush", page: "/ai/rag/",
      body: "durability review", color: "yellow", visibility: "public",
      target: { selectors: [], scope: "page" } }) });
  const deadline = Date.now() + 5000;
  while (store.annotations.length === 0) {
    assert(Date.now() < deadline, "annotation creation deadline");
    await setImmediate();
  }
  auth.issueSession({ githubId: 2, login: "review-two" });
  const response = await pending;
  const body = await response.json();
  while (store.lastError === null) {
    assert(Date.now() < deadline, "follow-up write failure deadline");
    await setImmediate();
  }
  const disk = new AnnotationStore(directory);
  await disk.load();
  const result = { injected, status: response.status, error: body.error,
    memoryCount: store.annotations.length, restartedCount: disk.annotations.length,
    restartedVisibility: disk.annotations[0]?.visibility };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: "127.0.0.1",
      PORT: new URL(base).port, DATA_DIR: directory, SEARCH_INDEX_URL: config.searchIndexUrl,
      DEV_AUTH_BYPASS: "true",
      TMPDIR: resolve("../meta/runtime") }, stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("restart readiness timeout")), 10000);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`restart exited ${code}`)); });
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes(base)) { clearTimeout(timer); resolve(); }
      });
    });
    const restartedResponse = await fetch(`${base}/api/annotations?page=/ai/rag/&scope=public`);
    const restartedBody = await restartedResponse.json();
    result.newProcessPublicCount = restartedBody.annotations.length;
    assert.equal(result.newProcessPublicCount, 1);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
  console.log(JSON.stringify(result, null, 2));
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  assert.equal(injected, true);
  assert.equal(response.status, 201);
  assert.equal(body.annotation.id, disk.annotations[0]?.id);
  assert.equal(store.annotations.length, 1);
  assert.equal(disk.annotations.length, 1);
} finally {
  watcher?.close();
  index.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => staticServer.close(() => resolve()));
}
