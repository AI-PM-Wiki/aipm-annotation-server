
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";

const root = resolve("..");
const search = await readFile(join(root, "site/search/search_index.json"));
const staticServer = createServer((req, res) => {
  assert.equal(req.url, "/search/search_index.json");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(search);
});
await new Promise(resolve => staticServer.listen(0, "127.0.0.1", resolve));
const indexUrl = `http://127.0.0.1:${staticServer.address().port}/search/search_index.json`;
const children = new Set();
let sequence = 0;

async function start(repository, dataDir) {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: join(root, repository),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HOST: "127.0.0.1",
      PORT: String(port), DATA_DIR: dataDir, DEV_AUTH_BYPASS: "true",
      SEARCH_INDEX_URL: indexUrl, TMPDIR: join(root, "runtime") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const logPath = join(root, "logs", `independent-process-${++sequence}.log`);
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  child.on("close", () => { children.delete(child); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`readiness timeout: ${output}`)), 10000);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`exit ${code}: ${output}`)); });
    child.stdout.on("data", () => {
      if (output.includes(base)) { clearTimeout(timer); resolve(); }
    });
  });
  return {
    async call(path, token, method = "GET", payload) {
      const response = await fetch(`${base}${path}`, { method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      return { status: response.status, body: await response.json() };
    },
    async stop(signal = "SIGTERM") {
      const ended = once(child, "exit");
      child.kill(signal);
      await ended;
      await writeFile(logPath, output);
    },
  };
}

const results = {};
try {
  const migrationDir = await mkdtemp(join(root, "runtime", "legacy-"));
  let app = await start("legacy", migrationDir);
  const login = await app.call("/api/auth/dev", undefined, "POST");
  assert.equal(login.status, 200);
  const token = login.body.token;
  const original = { requestId: "legacy-edited-request", page: "/ai/rag/", body: "original content",
    color: "yellow", visibility: "private", target: { scope: "page", selectors: [] } };
  const created = await app.call("/api/annotations", token, "POST", original);
  assert.equal(created.status, 201);
  const untouched = { ...original, requestId: "legacy-untouched-request" };
  const untouchedCreated = await app.call("/api/annotations", token, "POST", untouched);
  assert.equal(untouchedCreated.status, 201);
  const edited = await app.call(`/api/annotations/${created.body.annotation.id}`, token, "PATCH",
    { body: "edited content", visibility: "public" });
  assert.equal(edited.status, 200);
  await app.stop();
  const legacyDisk = JSON.parse(await readFile(join(migrationDir, "store.json"), "utf8"));
  assert.equal(legacyDisk.operations, undefined);
  app = await start("server", migrationDir);
  const migrated = await app.call(`/api/annotation-requests/${original.requestId}`, token);
  const originalReplay = await app.call("/api/annotations", token, "POST", original);
  const editedReplay = await app.call("/api/annotations", token, "POST",
    { ...original, body: "edited content", visibility: "public" });
  const untouchedReplay = await app.call("/api/annotations", token, "POST", untouched);
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.operation.originalRequestKnown, false);
  assert.equal(originalReplay.status, 409);
  assert.equal(editedReplay.status, 409);
  assert.equal(untouchedReplay.status, 409);
  assert.equal(untouchedReplay.body.error, "request_conflict");
  results.migration = { originalVisibility: original.visibility, migrated: migrated.body,
    originalReplayStatus: originalReplay.status, editedReplayStatus: editedReplay.status,
    untouchedReplayStatus: untouchedReplay.status };
  assert.equal(migrated.body.operation.page, undefined);
  assert.equal(migrated.body.operation.visibility, undefined);
  assert.equal((await app.call(`/api/annotations/${created.body.annotation.id}`, token, "DELETE")).status, 200);
  assert.equal((await app.call(`/api/annotation-requests/${original.requestId}`, token)).body.operation.deleted, true);
  assert.equal((await app.call("/api/annotations", token, "POST", original)).status, 409);
  const migratedDisk = JSON.parse(await readFile(join(migrationDir, "store.json"), "utf8"));
  assert.equal(migratedDisk.operations.find(item => item.requestId === original.requestId).evidence, "legacy");
  assert.equal(migratedDisk.operations.find(item => item.requestId === original.requestId).digest, null);
  assert.equal(migratedDisk.annotations.some(item => item.id === created.body.annotation.id), false);
  await app.stop();

  app = await start("server", migrationDir);
  assert.equal((await app.call(`/api/annotation-requests/${original.requestId}`, token)).body.operation.deleted, true);
  assert.equal((await app.call("/api/annotations", token, "POST", original)).status, 409);
  await app.stop();
  const failureDir = await mkdtemp(join(root, "runtime", "delete-failure-"));
  app = await start("server", failureDir);
  const failureLogin = await app.call("/api/auth/dev", undefined, "POST");
  const failureToken = failureLogin.body.token;
  const payload = { ...original, requestId: "delete-failure-request" };
  const saved = await app.call("/api/annotations", failureToken, "POST", payload);
  assert.equal(saved.status, 201);
  const id = saved.body.annotation.id;
  const edit = await app.call(`/api/annotations/${id}`, failureToken, "PATCH",
    { body: "new edited content", visibility: "public" });
  assert.equal(edit.status, 200);
  const editReplay = await app.call("/api/annotations", failureToken, "POST", payload);
  assert.equal(editReplay.status, 200);
  assert.equal(editReplay.body.annotation.id, id);
  assert.equal(editReplay.body.annotation.body, "new edited content");
  const editConflict = await app.call("/api/annotations", failureToken, "POST",
    { ...payload, body: "new edited content", visibility: "public" });
  assert.equal(editConflict.status, 409);
  const diskBeforeQueries = await readFile(join(failureDir, "store.json"), "utf8");
  const readOnlyReceipt = await app.call(`/api/annotation-requests/${payload.requestId}`, failureToken);
  assert.deepEqual(Object.keys(readOnlyReceipt.body.operation).sort(),
    ["annotationId", "createdAt", "deleted", "page", "status", "visibility"]);
  assert.equal(readOnlyReceipt.body.operation.visibility, "private");
  assert.equal((await app.call(`/api/annotation-requests/${payload.requestId}`)).status, 401);
  assert.equal((await app.call(`/api/annotation-requests/${payload.requestId}`, "invalid-token")).status, 401);
  assert.equal((await app.call("/api/annotation-requests/missing-request", failureToken)).status, 404);
  assert.equal((await app.call("/api/annotation-requests/bad", failureToken)).status, 400);
  assert.equal(await readFile(join(failureDir, "store.json"), "utf8"), diskBeforeQueries);
  results.currentEditAndReadOnly = { editReplayStatus: editReplay.status,
    editedPayloadStatus: editConflict.status, receipt: readOnlyReceipt.body,
    readOnlyDiskUnchanged: true, anonymousStatus: 401, invalidTokenStatus: 401,
    absentRecordStatus: 404, invalidRequestIdStatus: 400 };
  const barrier = join(failureDir, "store.json.tmp");
  await mkdir(barrier);
  const deletion = await app.call(`/api/annotations/${id}`, failureToken, "DELETE")
    .then(value => ({ response: value }), error => ({ connectionError: error.message }));
  assert.equal(typeof deletion.connectionError, "string");
  const beforeRestart = await app.call(`/api/annotation-requests/${payload.requestId}`, failureToken);
  const replay = await app.call("/api/annotations", failureToken, "POST", payload);
  const disk = JSON.parse(await readFile(join(failureDir, "store.json"), "utf8"));
  assert(disk.annotations.some(annotation => annotation.id === id));
  assert.equal(beforeRestart.body.operation.deleted, false);
  assert.equal(replay.body.annotation.id, id);
  await app.stop("SIGKILL");
  await rmdir(barrier);
  app = await start("server", failureDir);
  const afterRestart = await app.call(`/api/annotation-requests/${payload.requestId}`, failureToken);
  assert.equal(afterRestart.body.operation.deleted, false);
  assert.equal(afterRestart.body.operation.annotationId, id);
  results.failedDeletion = { deletion, beforeRestart: beforeRestart.body,
    replay: replay.body, persistedAnnotationCount: disk.annotations.length,
    afterRestart: afterRestart.body };
  await app.stop();
  await writeFile(join(root, "logs", "independent-http-result.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  }
  await new Promise(resolve => staticServer.close(resolve));
}
