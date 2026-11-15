// APD13：独立 HTTP 浏览器运行生产归档 hook；服务端口只操作本轮内存夹具。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const insecureHostname = "archive-http-source.invalid";
const uuidv4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const source = String.raw`
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Emitter } from "@zcode/rpc";
import {
  buildServerRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity, ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import {
  controllerSubscribeResultSchema, v4SessionDeletionPreviewSchema, v4SessionDeletionResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "./src/hooks/useServices.tsx";
import { TabStoreProvider } from "./src/store/TabStoreProvider.tsx";
import { ZCodeIntlProvider } from "./src/i18n/IntlProvider.tsx";
import { ProjectDirectoryProvider } from "./src/project-sidebar/ProjectDirectoryProvider.tsx";
import { useArchiveManagement } from "./src/project-sidebar/useArchiveManagement.ts";
import { ConfirmDialogHost } from "./src/ConfirmDialog.tsx";
import { useConfirmDialogStore } from "./src/store/confirmDialogStore.ts";
import { useZCodeSessionStore } from "./src/store/zcodeSessionStore.ts";
import {
  createDefaultWorkspaceState, DEFAULT_TASK_UI_STATE, DEFAULT_TASK_RUNTIME_STATE,
} from "./src/store/zcodeSessionStoreTypes.ts";
import {
  getBrowserVisitScopeKey, recordBrowserVisit, readBrowserRecentVisits,
} from "./src/store/browserRecentVisitsStore.ts";
import {
  registerRemoteWorkspaceSession, bindRemoteWorkspaceIdentity, bindRemoteWorkspacePath,
} from "./src/store/remoteWorkspaceSessionStore.ts";
import { logger } from "./src/logger.ts";

const query = new URL(location.href).searchParams;
const owner = query.get("owner") ?? "source";
const held = query.get("held") === "true";
const outcome = query.get("outcome") ?? "deleted";
const workspacePath = "archive-fixture-workspace";
const identity = buildServerRemoteWorkspaceIdentity({ serverId: "archive-owner", workspacePath });
const otherIdentity = buildServerRemoteWorkspaceIdentity({ serverId: "other-owner", workspacePath });
const remoteSessionId = "archive-attachment";
const hostId = remoteHostIdFromWorkspaceIdentity(identity);
const task = (taskId, archived = true) => ({
  taskId, traceId: "archive-trace-" + taskId, title: "Fixture " + taskId,
  workspacePath, workspaceIdentity: identity, createdAt: 1, updatedAt: 2,
  mode: "default", projectId: null, hostId, pinned: false, archived,
});
const first = task("archive-first");
const second = task("archive-second");
const active = task("archive-active", false);
const childId = "archive-child";
const untouchedId = "archive-untouched";
const candidates = [first, first, second, active];
let tree = { projects: [], tasks: [first, second, active] };
let readCount = 0;
const calls = { previews: [], deletes: [], subscriptions: [], unsubscriptions: [] };
const pendingPreviews = new Map();
const operationErrors = [];
const unexpectedErrors = [];
const emitters = Array.from({ length: 4 }, () => new Emitter());
const [broadcast, workspaceEvents, frames, unreadSignals] = emitters;
const preview = (taskId) => v4SessionDeletionPreviewSchema.parse({
  sessionId: taskId, revision: "revision-" + taskId,
  sessionIds: taskId === first.taskId ? [taskId, childId] : [taskId],
  forks: [], retainedArtifacts: [], deletedFiles: 2, incomplete: false, completed: true,
});
function prepare(route, params) {
  const taskId = route === "controller" ? params.address.taskId : params.taskId;
  const index = calls.previews.length;
  calls.previews.push({ route, params });
  if (!held) return Promise.resolve(preview(taskId));
  return new Promise((resolve) => pendingPreviews.set(index, { resolve, taskId }));
}
function execute(route, params) {
  const taskId = route === "controller" ? params.address.taskId : params.taskId;
  calls.deletes.push({ route, params });
  const status = taskId === second.taskId ? outcome : "deleted";
  const result = v4SessionDeletionResultSchema.parse({
    sessionId: taskId, status, sessionIds: preview(taskId).sessionIds, retainedArtifacts: 1,
    ...(status === "blocked" ? { reason: "changed" } : {}),
  });
  if (status === "deleted")
    tree = { ...tree, tasks: tree.tasks.filter((entry) => !result.sessionIds.includes(entry.taskId)) };
  return Promise.resolve(result);
}
const service = {
  onDynamicWorkspaceEvent: () => workspaceEvents.event,
  previewArchivedTaskDeletion: (params) => prepare("source", params),
  permanentlyDeleteArchivedTask: (params) => execute("source", params),
};
const controller = {
  onDynamicControllerFrame: () => frames.event,
  onDynamicTaskUnreadSignal: () => unreadSignals.event,
  async subscribeControllerV4(params) {
    const subscriptionId = "fixture-subscription-" + calls.subscriptions.length;
    calls.subscriptions.push({ ...params, subscriptionId });
    return controllerSubscribeResultSchema.parse({
      ack: { subscriptionId, mode: "snapshot", logEpoch: "fixture-epoch" },
    });
  },
  async unsubscribeControllerV4(params) { calls.unsubscriptions.push(params); },
  async listTaskList() { return { items: [], total: 0, hasMore: false }; },
  previewArchivedTaskDeletion: (params) => prepare("controller", params),
  permanentlyDeleteArchivedTask: (params) => execute("controller", params),
};
// 不装配完整服务工厂、Agent 或网络代理；缺席的可选能力沿用生产 hook 的降级合同。
const services = {
  projectService: { async readTree() { readCount++; return tree; } },
  broadcastService: { onMessage: broadcast.event },
  zcodeTaskService: service,
  ...(owner === "controller" ? { windowControllerService: controller } : {}),
};
registerRemoteWorkspaceSession({ sessionId: remoteSessionId, workspacePath,
  workspaceIdentity: identity, sourceServerId: "archive-owner", services });
bindRemoteWorkspaceIdentity(identity, remoteSessionId);
registerRemoteWorkspaceSession({ sessionId: "other-attachment", workspacePath,
  workspaceIdentity: otherIdentity, sourceServerId: "other-owner", services });
bindRemoteWorkspaceIdentity(otherIdentity, "other-attachment");
// 同 cwd 的兼容索引故意指向另一设备；带 identity 的目标不得采用它。
bindRemoteWorkspacePath(workspacePath, "other-attachment");
const stateIds = [first.taskId, childId, second.taskId, untouchedId];
const buckets = {};
const visitScopes = [];
for (const workspaceKey of [identity, otherIdentity]) {
  const bucket = createDefaultWorkspaceState(ZCODE_AGENT_PROVIDER);
  bucket.activeTaskId = first.taskId;
  for (const taskId of stateIds) {
    bucket.taskUiByTaskId[taskId] = { ...DEFAULT_TASK_UI_STATE };
    bucket.taskRuntimeByTaskId[taskId] = { ...DEFAULT_TASK_RUNTIME_STATE };
    bucket.taskUnreadByTaskId[taskId] = true;
    bucket.optimisticTaskListByTaskId[taskId] = { ...task(taskId), workspaceIdentity: workspaceKey };
    for (const attachment of [remoteSessionId, "previous-attachment"]) {
      const scopeKey = getBrowserVisitScopeKey({ workspaceKey, remoteSessionId: attachment,
        sessionId: taskId });
      recordBrowserVisit(scopeKey, { url: "http://fixture-visit.invalid/" + taskId,
        title: "Fixture visit", faviconUrl: null, lastVisitedAt: 1 });
      visitScopes.push({ workspaceKey, taskId, scopeKey });
    }
  }
  buckets[workspaceKey] = bucket;
}
useZCodeSessionStore.setState({ workspaces: buckets });
const logError = logger.error;
logger.error = (...args) => {
  if (args[0] === "[archive-management] 任务操作失败")
    operationErrors.push(args[1].error.message);
  else unexpectedErrors.push(String(args[0]));
  logError(...args);
};
let management;
let setHost;
let finishedRuns = 0;
function start() {
  void management.run(candidates, "delete").then(
    () => { finishedRuns++; },
    (error) => { unexpectedErrors.push(error.message); finishedRuns++; },
  );
}
function Fixture() {
  management = useArchiveManagement();
  const [showHost, updateHost] = useState(query.get("host") !== "false");
  setHost = updateHost;
  return <>
    <button disabled={management.loading || management.busy} onClick={start}>Delete fixture archives</button>
    <output data-testid="archive-fixture-status">{management.loading ? "loading" : management.busy ? "busy" : "ready"}</output>
    {showHost && <ConfirmDialogHost />}
  </>;
}
const root = createRoot(document.getElementById("root"));
root.render(<StrictMode><ServiceProvider services={services}><TabStoreProvider>
  <ZCodeIntlProvider initialLocale="en-US"><ProjectDirectoryProvider><Fixture />
  </ProjectDirectoryProvider></ZCodeIntlProvider>
</TabStoreProvider></ServiceProvider></StrictMode>);
globalThis.archiveFixture = {
  snapshot() {
    const request = useConfirmDialogStore.getState().pendingRequest;
    const workspaces = useZCodeSessionStore.getState().workspaces;
    return {
      owner, identity, otherIdentity, workspacePath, remoteSessionId, hostId, readCount,
      capabilities: { secure: isSecureContext, randomUUID: typeof crypto.randomUUID,
        getRandomValues: typeof crypto.getRandomValues },
      loading: management?.loading, busy: management?.busy, result: management?.result,
      finishedRuns, calls, operationErrors, unexpectedErrors,
      pending: request ? { title: request.title, description: request.description,
        disabled: request.confirmDisabled, intent: request.intent } : null,
      state: Object.fromEntries([identity, otherIdentity].map((key) => [key, {
        activeTaskId: workspaces[key].activeTaskId,
        ui: Object.keys(workspaces[key].taskUiByTaskId),
        runtime: Object.keys(workspaces[key].taskRuntimeByTaskId),
        unread: Object.keys(workspaces[key].taskUnreadByTaskId),
        optimistic: Object.keys(workspaces[key].optimisticTaskListByTaskId),
      }])),
      visits: visitScopes.map((scope) => ({ ...scope,
        count: readBrowserRecentVisits(scope.scopeKey).length,
        persisted: localStorage.getItem("zcode-browser-recent-visits:" + scope.scopeKey) !== null,
      })),
      weakRandomCalls: globalThis.weakRandomCalls ?? 0,
    };
  },
  mountHost() { setHost(true); },
  repeat() { start(); },
  releasePreview(index) {
    const pending = pendingPreviews.get(index);
    if (!pending) throw new Error("fixture.preview-not-pending:" + index);
    pendingPreviews.delete(index);
    pending.resolve(preview(pending.taskId));
  },
  async dispose() {
    root.unmount();
    for (const pending of pendingPreviews.values()) pending.resolve(preview(pending.taskId));
    pendingPreviews.clear();
    await Promise.resolve();
    emitters.forEach((emitter) => emitter.dispose());
  },
};
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Isolated archive HTTP acceptance</title>
<style>body{font-family:sans-serif} [role=dialog]{position:fixed;inset:10%;background:white;padding:20px;overflow:auto}</style>
</head><body><div id="root"></div><script type="module" src="/source.js"></script></body></html>`;

async function createProbe() {
  const bundle = await build({
    absWorkingDir: repoRoot,
    stdin: { contents: source, resolveDir: resolve(repoRoot, "packages", "ui"), loader: "tsx" },
    tsconfig: resolve(repoRoot, "packages", "ui", "tsconfig.json"),
    alias: { "@": resolve(repoRoot, "packages", "ui", "src") },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env.DEV": "true",
      "import.meta.env.PROD": "false",
      "import.meta.env.MODE": '"test"',
      __ZCODE_ENV__: '"test"',
      __ZCODE_VERSION__: '"fixture"',
    },
    write: false,
  });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    if (pathname === "/source.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else if (pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    } else response.writeHead(404).end();
  });
  const close = () =>
    new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url)).status, 200);
    return { url, close };
  } catch (error) {
    if (server.listening) await close();
    throw error;
  }
}

const snapshot = (page) => page.evaluate(() => globalThis.archiveFixture.snapshot());
const waitForPreviews = (page, count) =>
  page.waitForFunction(
    (count) => globalThis.archiveFixture.snapshot().calls.previews.length === count,
    count,
  );
const waitForResult = (page) =>
  page.waitForFunction(() => {
    const state = globalThis.archiveFixture.snapshot();
    return !state.busy && state.result !== null;
  });
async function begin(page) {
  await page.getByRole("button", { name: "Delete fixture archives" }).click();
  await page.locator('[data-confirm-intent="archive-management-delete"]').waitFor();
}
async function confirmReady(page) {
  await page.waitForFunction(
    () => globalThis.archiveFixture.snapshot().pending?.disabled === false,
  );
  await page.getByTestId("confirm-dialog-confirm").click();
  await waitForResult(page);
}
async function cancel(page) {
  await page
    .locator('[data-confirm-intent="archive-management-delete"]')
    .getByRole("button", { name: /^Cancel/ })
    .click();
  await page.waitForFunction(() => !globalThis.archiveFixture.snapshot().busy);
}
function assertCleanup(result, deletedIds) {
  const allIds = ["archive-first", "archive-child", "archive-second", "archive-untouched"];
  for (const key of [result.identity, result.otherIdentity]) {
    const kept = allIds.filter((id) => key !== result.identity || !deletedIds.includes(id));
    for (const field of ["ui", "runtime", "unread", "optimistic"])
      assert.deepEqual(result.state[key][field].sort(), [...kept].sort());
    assert.equal(
      result.state[key].activeTaskId,
      key === result.identity && deletedIds.includes("archive-first") ? null : "archive-first",
    );
  }
  for (const visit of result.visits) {
    const kept = visit.workspaceKey !== result.identity || !deletedIds.includes(visit.taskId);
    assert.equal(visit.count, kept ? 1 : 0);
    assert.equal(visit.persisted, kept);
  }
}
async function successfulDelete(page, test) {
  await begin(page);
  await confirmReady(page);
  const result = await snapshot(page);
  assert.deepEqual(result.capabilities, {
    secure: !test.insecure,
    randomUUID: test.insecure ? "undefined" : "function",
    getRandomValues: "function",
  });
  assert.equal(result.calls.previews.length, 2);
  assert.equal(result.calls.deletes.length, 2, JSON.stringify(result.operationErrors));
  assert.equal(result.result.succeeded, test.outcome ? 1 : 2);
  assert.equal(result.result.failed, test.outcome === "incomplete" ? 1 : 0);
  assert.equal(result.result.skipped, test.outcome === "blocked" ? 1 : 0);
  assert.equal(result.operationErrors.length, 0);
  const ids = new Set();
  for (let index = 0; index < result.calls.deletes.length; index++) {
    const write = result.calls.deletes[index];
    const read = result.calls.previews[index];
    assert.equal(write.route, test.owner);
    assert.match(write.params.operationId, uuidv4);
    ids.add(write.params.operationId);
    const taskId = index === 0 ? "archive-first" : "archive-second";
    assert.equal(write.params.revision, `revision-${taskId}`);
    if (test.owner === "controller") {
      assert.deepEqual(write.params.address, {
        workspacePath: result.workspacePath,
        workspaceIdentity: result.identity,
        taskId,
        remoteSessionId: result.remoteSessionId,
        sourceServerId: "archive-owner",
      });
      assert.deepEqual(write.params.address, read.params.address);
    } else {
      assert.deepEqual(
        Object.keys(write.params).sort(),
        [...Object.keys(read.params), "revision", "operationId"].sort(),
      );
      assert.equal(write.params.workspaceIdentity, result.identity);
      assert.equal(write.params.workspacePath, result.workspacePath);
      assert.equal(write.params.remoteSessionId, undefined);
      assert.equal(write.params.sourceServerId, undefined);
    }
  }
  assert.equal(ids.size, 2);
  assertCleanup(result, [
    "archive-first",
    "archive-child",
    ...(test.outcome ? [] : ["archive-second"]),
  ]);
}

const tests = [
  ...["source", "controller"].flatMap((owner) =>
    [false, true].map((insecure) => ({
      id: `APD13-${owner}-${insecure ? "http" : "secure-control"}`,
      owner,
      insecure,
      run: successfulDelete,
    })),
  ),
  {
    id: "APD13-dom-preparation-and-cancel",
    owner: "source",
    insecure: true,
    host: false,
    held: true,
    async run(page) {
      await page.getByRole("button", { name: "Delete fixture archives" }).click();
      const before = await snapshot(page);
      assert.equal(before.busy, true);
      assert.equal(before.pending.disabled, true);
      assert.equal(before.calls.previews.length, 0);
      await page.evaluate(() => globalThis.archiveFixture.mountHost());
      await waitForPreviews(page, 1);
      assert.equal(await page.getByTestId("confirm-dialog-confirm").isDisabled(), true);
      await page.evaluate(() => globalThis.archiveFixture.repeat());
      assert.equal((await snapshot(page)).calls.previews.length, 1);
      await cancel(page);
      await page.evaluate(() => globalThis.archiveFixture.releasePreview(0));
      const after = await snapshot(page);
      assert.equal(after.pending, null);
      assert.equal(after.result, null);
      assert.equal(after.calls.previews.length, 1);
      assert.equal(after.calls.deletes.length, 0);
      assertCleanup(after, []);
    },
  },
  {
    id: "APD13-cancelled-preview-cannot-update-next-dialog",
    owner: "source",
    insecure: true,
    held: true,
    async run(page) {
      await begin(page);
      await waitForPreviews(page, 1);
      await cancel(page);
      await begin(page);
      await waitForPreviews(page, 2);
      const before = (await snapshot(page)).pending;
      await page.evaluate(() => globalThis.archiveFixture.releasePreview(0));
      const after = await snapshot(page);
      assert.deepEqual(after.pending, before);
      assert.equal(after.calls.previews.length, 2);
      assert.equal(after.calls.deletes.length, 0);
      await cancel(page);
      await page.evaluate(() => globalThis.archiveFixture.releasePreview(1));
      assert.equal((await snapshot(page)).pending, null);
    },
  },
  {
    id: "APD13-cancel-after-preparation",
    owner: "controller",
    insecure: true,
    async run(page) {
      await begin(page);
      await page.waitForFunction(
        () => globalThis.archiveFixture.snapshot().pending?.disabled === false,
      );
      await cancel(page);
      const result = await snapshot(page);
      assert.equal(result.calls.previews.length, 2);
      assert.equal(result.calls.deletes.length, 0);
      assert.equal(result.result, null);
      assertCleanup(result, []);
    },
  },
  ...["source", "controller"].map((owner) => ({
    id: `APD13-${owner}-no-secure-random`,
    owner,
    insecure: true,
    noRandom: true,
    async run(page) {
      await begin(page);
      await page.waitForFunction(
        () => globalThis.archiveFixture.snapshot().pending?.disabled === false,
      );
      const before = (await snapshot(page)).weakRandomCalls;
      await confirmReady(page);
      const result = await snapshot(page);
      assert.equal(result.result.failed, 2);
      assert.equal(result.result.succeeded, 0);
      assert.equal(result.calls.deletes.length, 0);
      assert.deepEqual(result.operationErrors, [
        "uuid.secure-random-unavailable",
        "uuid.secure-random-unavailable",
      ]);
      assert.equal(result.weakRandomCalls, before);
      assertCleanup(result, []);
    },
  })),
  {
    id: "APD13-source-blocked-preserves-state",
    owner: "source",
    insecure: true,
    outcome: "blocked",
    run: successfulDelete,
  },
  {
    id: "APD13-controller-incomplete-preserves-state",
    owner: "controller",
    insecure: true,
    outcome: "incomplete",
    run: successfulDelete,
  },
];

async function runChecks(probe) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      `--host-resolver-rules=MAP ${insecureHostname} 127.0.0.1`,
      "--proxy-server=direct://",
      "--proxy-bypass-list=*",
    ],
    ...(process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : process.env.PLAYWRIGHT_CHROMIUM_CHANNEL
        ? { channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL }
        : {}),
  });
  const results = [];
  try {
    for (const test of tests) {
      const context = await browser.newContext();
      let page;
      try {
        const url = new URL(probe.url);
        if (test.insecure) url.hostname = insecureHostname;
        for (const name of ["owner", "host", "held", "outcome"])
          if (test[name] !== undefined) url.searchParams.set(name, String(test[name]));
        const externalRequests = [];
        const pageErrors = [];
        await context.route("**/*", (route) => {
          if (new URL(route.request().url()).origin === url.origin) return route.continue();
          externalRequests.push(route.request().url());
          return route.abort("blockedbyclient");
        });
        if (test.noRandom)
          await context.addInitScript(() => {
            Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
            const random = Math.random;
            globalThis.weakRandomCalls = 0;
            Math.random = () => {
              globalThis.weakRandomCalls++;
              return random();
            };
          });
        page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(url.href);
        await page.getByTestId("archive-fixture-status").filter({ hasText: "ready" }).waitFor();
        await test.run(page, test);
        const result = await snapshot(page);
        assert.deepEqual(result.unexpectedErrors, []);
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(externalRequests, []);
        results.push({ id: test.id, passed: true });
      } catch (error) {
        results.push({ id: test.id, passed: false, error: error.message });
      } finally {
        try {
          if (page && !page.isClosed())
            await page.evaluate(() => globalThis.archiveFixture?.dispose());
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ layer: "isolated-production-source-browser", results }, null, 2));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

const probe = await createProbe();
try {
  await runChecks(probe);
} finally {
  await probe.close();
}
