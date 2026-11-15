// PD17–19：真实 HTTP 能力与生产 factory/pending store；不装配 fake admission。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const insecureHostname = "send-http-source.invalid";
const uuidv4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const source = `
import { createCommandEnvelope } from "./src/v4/commandFactory.ts";
import {
  ensurePendingTaskDraft, readPendingTaskDraft, bindPendingTaskDraft,
  completePendingTaskDraft, markPendingTaskDraftCommand, releasePendingTaskDraftCommand,
} from "./src/v4/composer/composerDraftStore.ts";
const scope = { clientNamespace: "send-http-fixture", hostId: "local", projectId: null };
const attempt = (action) => {
  try { return { value: action() }; }
  catch (error) { return { error: error.message }; }
};
export function run() {
  const result = {
    capabilities: { secure: isSecureContext, randomUUID: typeof crypto.randomUUID,
      getRandomValues: typeof crypto.getRandomValues },
    command: attempt(() => createCommandEnvelope({ type: "createSession",
      payload: { workspaceId: "send-http-fixture" }, sessionId: null })),
    draft: attempt(() => ensurePendingTaskDraft(scope)),
  };
  if (result.command.value && result.draft.value) {
    const command = result.command.value;
    const draft = result.draft.value;
    result.explicit = createCommandEnvelope({ type: "createSession", sessionId: null,
      payload: { workspaceId: "send-http-fixture", sessionId: command.payload.sessionId } });
    bindPendingTaskDraft(scope, draft.draftId, "fixture-workspace");
    result.bound = ensurePendingTaskDraft(scope);
    markPendingTaskDraftCommand(scope, draft.draftId, command.commandId, command.payload.sessionId);
    result.competing = attempt(() => markPendingTaskDraftCommand(scope, draft.draftId,
      result.explicit.commandId, command.payload.sessionId));
    completePendingTaskDraft(scope, draft.draftId);
    result.next = ensurePendingTaskDraft(scope);
    bindPendingTaskDraft(scope, result.next.draftId, "next-fixture-workspace");
    markPendingTaskDraftCommand(scope, result.next.draftId, result.explicit.commandId,
      result.explicit.payload.sessionId);
    releasePendingTaskDraftCommand(scope, draft.draftId, command.commandId);
    completePendingTaskDraft(scope, draft.draftId);
    result.afterLateAck = readPendingTaskDraft(scope);
    result.otherScope = ensurePendingTaskDraft({ ...scope, hostId: "other-host" });
    result.otherClientScope = ensurePendingTaskDraft({ ...scope, clientNamespace: "other-client" });
    result.otherProjectScope = ensurePendingTaskDraft({ ...scope, projectId: "other-project" });
  }
  result.stored = attempt(() => Object.keys(localStorage)
    .filter(key => key.startsWith("zcode-pending-task-draft:")));
  result.weakRandomCalls = globalThis.weakRandomCalls ?? 0;
  result.pendingWriteAttempts = globalThis.pendingWriteAttempts ?? 0;
  document.querySelector("pre").textContent = JSON.stringify(result, null, 2);
  return result;
}
globalThis.snapshotSendHttpDraft = () => readPendingTaskDraft(scope);
document.querySelector("button").addEventListener("click", run);
`;
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>PD17–19 production-source HTTP send identities</h1><button>Run send identity checks</button>
<pre></pre><script type="module" src="/source.js"></script></body></html>`;

export async function createSendHttpProbe() {
  const bundle = await build({
    absWorkingDir: repoRoot,
    stdin: { contents: source, resolveDir: resolve(repoRoot, "packages", "ui"), loader: "ts" },
    tsconfig: resolve(repoRoot, "packages", "ui", "tsconfig.json"),
    alias: { "@": resolve(repoRoot, "packages", "ui", "src") },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: {
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": '"production"',
      __ZCODE_ENV__: '"test"',
      __ZCODE_VERSION__: '"fixture"',
    },
    write: false,
  });
  const script = bundle.outputFiles[0].contents;
  const server = createServer((request, response) => {
    if (request.url === "/source.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(script);
    } else if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    } else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url)).status, 200);
  return { url, close: () => new Promise((done) => server.close(done)), html, script };
}

async function runChecks(probe) {
  const insecureUrl = new URL(probe.url);
  insecureUrl.hostname = insecureHostname;
  const browser = await chromium.launch({
    headless: true,
    // 域名映射仅作用于本轮独立浏览器，普通 HTTP 的生产源码请求始终留在 loopback。
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
    for (const insecure of [false, true]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(insecure ? insecureUrl.href : probe.url);
        await page.waitForFunction(() => typeof globalThis.snapshotSendHttpDraft === "function");
        await page.getByRole("button", { name: "Run send identity checks" }).click();
        const result = JSON.parse(await page.locator("pre").textContent());
        assert.deepEqual(result.capabilities, {
          secure: !insecure,
          randomUUID: insecure ? "undefined" : "function",
          getRandomValues: "function",
        });
        assert.equal(result.command.error, undefined);
        assert.equal(result.draft.error, undefined);
        assert.match(result.command.value.payload.sessionId.slice(5), uuidv4);
        assert.ok(result.command.value.payload.sessionId.startsWith("sess_"));
        assert.match(result.draft.value.draftId, uuidv4);
        assert.equal(result.explicit.payload.sessionId, result.command.value.payload.sessionId);
        assert.equal(result.bound.draftId, result.draft.value.draftId);
        assert.equal(result.bound.workspacePath, "fixture-workspace");
        assert.equal(result.competing.error, "composer.draft-submission-pending");
        assert.notEqual(result.next.draftId, result.draft.value.draftId);
        assert.equal(result.afterLateAck.draftId, result.next.draftId);
        assert.equal(result.afterLateAck.commandId, result.explicit.commandId);
        assert.equal(
          new Set([
            result.next.draftId,
            result.otherScope.draftId,
            result.otherClientScope.draftId,
            result.otherProjectScope.draftId,
          ]).size,
          4,
        );
        await page.reload();
        await page.waitForFunction(() => typeof globalThis.snapshotSendHttpDraft === "function");
        assert.deepEqual(
          await page.evaluate(() => globalThis.snapshotSendHttpDraft()),
          result.afterLateAck,
        );
        results.push({ insecure, sessionId: result.command.value.payload.sessionId, passed: true });
      } finally {
        await context.close();
      }
    }
    for (const failure of ["random", "storage", "storage-write"]) {
      const context = await browser.newContext();
      try {
        await context.addInitScript((failure) => {
          if (failure === "random") {
            Object.defineProperty(globalThis, "crypto", { value: {} });
            const random = Math.random;
            globalThis.weakRandomCalls = 0;
            Math.random = () => {
              globalThis.weakRandomCalls++;
              return random();
            };
          } else if (failure === "storage")
            Object.defineProperty(globalThis, "localStorage", {
              get() {
                throw new Error("fixture storage denied");
              },
            });
          else {
            const setItem = Storage.prototype.setItem;
            globalThis.pendingWriteAttempts = 0;
            Storage.prototype.setItem = function (key, value) {
              if (key.startsWith("zcode-pending-task-draft:")) {
                globalThis.pendingWriteAttempts++;
                throw new Error("fixture pending storage denied");
              }
              return setItem.call(this, key, value);
            };
          }
        }, failure);
        const page = await context.newPage();
        await page.goto(probe.url);
        await page.waitForFunction(() => typeof globalThis.snapshotSendHttpDraft === "function");
        await page.getByRole("button", { name: "Run send identity checks" }).click();
        const result = JSON.parse(await page.locator("pre").textContent());
        if (failure === "random") {
          assert.equal(result.command.error, "uuid.secure-random-unavailable");
          assert.equal(result.draft.error, "uuid.secure-random-unavailable");
          assert.equal(result.weakRandomCalls, 0);
          assert.deepEqual(result.stored.value, []);
        } else if (failure === "storage")
          assert.equal(result.draft.error, "composer.draft-storage-unavailable");
        else {
          assert.equal(result.draft.error, "fixture pending storage denied");
          assert.equal(result.pendingWriteAttempts, 1);
          assert.deepEqual(result.stored.value, []);
        }
        results.push({ failure, passed: true });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ layer: "production-source-browser", results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const probe = await createSendHttpProbe();
  if (process.argv.includes("--serve")) {
    console.log(`SEND_HTTP_PROBE_READY ${probe.url}`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void probe.close());
  } else {
    try {
      await runChecks(probe);
    } finally {
      await probe.close();
    }
  }
}
