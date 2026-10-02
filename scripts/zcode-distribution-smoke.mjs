// 在仓库外验证发行包，避免开发机 node_modules 掩盖缺失的 TUI/native/worker 依赖。
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const archive = process.argv[2];
assert.ok(archive, "Usage: node scripts/zcode-distribution-smoke.mjs <archive.tar.gz>");
const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-release-smoke-")));
const root = join(directory, "zcode");
const runner = join(root, "bin/zcode.mjs");
const workspace = join(directory, "workspace");
const socketPath = process.platform === "win32" ? undefined : join(directory, "zcode.sock");
const env = {
  ...process.env,
  ZCODE_DATA_BASE_DIR: join(directory, "data"),
  NODE_PATH: "",
  NODE_OPTIONS: "",
  TERM: "xterm-256color",
};
let web;
let terminal;
try {
  await exec("tar", ["-xzf", resolve(archive), "-C", directory]);
  await mkdir(workspace);
  await exec(process.execPath, [runner, "--help"], { cwd: workspace, env });
  const version = (
    await exec(process.execPath, [runner, "--version"], { cwd: workspace, env })
  ).stdout.trim();
  const require = createRequire(join(root, "package.json"));
  const pty = require("node-pty");
  const runtimeCheck = join(root, "agent/check-tui.mjs");
  await writeFile(
    runtimeCheck,
    'import { runTui } from "@zcode/tui"; if (typeof runTui !== "function") throw new Error("Missing TUI export"); console.log("tui-runtime-ok");',
  );
  const imported = await exec(process.execPath, [runtimeCheck], { cwd: workspace, env });
  assert.match(imported.stdout, /tui-runtime-ok/);

  terminal = pty.spawn(process.execPath, [runner], { cwd: workspace, env, cols: 110, rows: 32 });
  let screen = "";
  let terminalExit;
  terminal.onData((data) => {
    screen += data;
  });
  const tuiExited = new Promise((done) =>
    terminal.onExit((event) => {
      terminalExit = event;
      done(event);
    }),
  );
  await until(
    () => /ZCode/.test(screen) && /(?:登录|\/login|输入提示词|Type a prompt)/i.test(screen),
    "TUI initialized render",
    () => screen,
  );
  assert.equal(terminalExit, undefined, screen);
  assert.doesNotMatch(screen, /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/);
  // 保留真实键盘退出链路；不发送 prompt，不调用模型。
  terminal.write("\u0003");
  await setTimeout(200);
  if (!terminalExit) terminal.write("\u0003");
  const tuiExit = await Promise.race([
    tuiExited,
    setTimeout(8000).then(() => {
      throw new Error("TUI keyboard exit timed out");
    }),
  ]);
  assert.equal(tuiExit.exitCode, 0, screen);
  terminal = undefined;

  let webOutput = "";
  const tcpToken = "zcode-smoke-token";
  const webArgs = [
    runner,
    "--web",
    "--workspace",
    workspace,
    "--no-open",
    "--token",
    tcpToken,
  ];
  if (socketPath) {
    webArgs.push("--socket", socketPath);
  }
  web = spawn(process.execPath, webArgs, {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout.on("data", (data) => {
    webOutput += data;
  });
  web.stderr.on("data", (data) => {
    webOutput += data;
  });
  let base;
  await until(
    () => {
      base = webOutput.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      return Boolean(base);
    },
    "Web URL",
    () => webOutput,
  );
  let info;
  await until(
    async () => {
      try {
        // 相对 URL 会丢弃基地址的查询串，Token 必须加在最终 API 地址上。
        const infoUrl = new URL("api/server-info", base);
        infoUrl.searchParams.set("token", tcpToken);
        const response = await fetch(infoUrl, {
          signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) return false;
        info = await response.json();
        return true;
      } catch {
        return false;
      }
    },
    "Web readiness",
    () => webOutput,
  );
  assert.equal(info.workspaces[0].path, workspace);
  const publicBase = new URL(base);
  publicBase.search = "";
  const unauthorizedInfo = await fetch(new URL("api/server-info", publicBase));
  assert.equal(unauthorizedInfo.status, 401);
  const html = await fetch(publicBase);
  assert.equal(html.status, 200);
  const htmlText = await html.text();
  assert.match(htmlText, /<html/i);
  const assetPaths = [...htmlText.matchAll(/(?:src|href)=["'](?:\/|\.\/)(assets\/[^"']+)["']/g)].map(
    ([, assetPath]) => `/${assetPath}`,
  );
  assert.ok(assetPaths.length > 0, "Web HTML has no generated asset references");
  for (const assetPath of assetPaths) {
    const asset = await fetch(new URL(assetPath, base));
    assert.equal(asset.status, 200, assetPath);
    assert.notEqual(asset.headers.get("content-type"), null, assetPath);
  }
  const { default: WebSocket } = await import(pathToFileURL(require.resolve("ws")).href);
  const unauthorizedWebSocket = new WebSocket(
    new URL("ws", publicBase.toString().replace("http:", "ws:")),
  );
  const unauthorizedWebSocketStatus = await new Promise((resolveStatus, rejectStatus) => {
    unauthorizedWebSocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    unauthorizedWebSocket.once("error", rejectStatus);
  });
  assert.equal(unauthorizedWebSocketStatus, 401);
  const tcpWebSocketUrl = new URL("ws", publicBase.toString().replace("http:", "ws:"));
  tcpWebSocketUrl.searchParams.set("token", tcpToken);
  const tcpSocket = new WebSocket(tcpWebSocketUrl);
  await once(tcpSocket, "open");
  tcpSocket.close();
  await once(tcpSocket, "close");

  if (socketPath) {
    const unixInfo = await requestOverSocket(socketPath, "/api/server-info");
    assert.equal(unixInfo.statusCode, 200);
    assert.equal(JSON.parse(unixInfo.body).workspaces[0].path, workspace);
    const unixHtml = await requestOverSocket(socketPath, "/");
    assert.equal(unixHtml.statusCode, 200);
    assert.match(unixHtml.headers["content-type"] ?? "", /text\/html/);
    for (const assetPath of assetPaths) {
      const asset = await requestOverSocket(socketPath, assetPath);
      assert.equal(asset.statusCode, 200, `unix://${assetPath}`);
      assert.match(asset.headers["content-type"] ?? "", /\S+/, `unix://${assetPath}`);
    }
    const unixSocket = new WebSocket("ws://localhost/ws", { socketPath });
    await once(unixSocket, "open");
    unixSocket.close();
    await once(unixSocket, "close");
  }

  const exited = once(web, "exit");
  web.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  if (socketPath) {
    await until(
      async () => !(await stat(socketPath).catch(() => null)),
      "Unix Socket cleanup",
      () => socketPath,
    );
  }
  web = undefined;
  console.log(
    JSON.stringify({
      version,
      platform: process.platform,
      arch: process.arch,
      tui: "native import, initialized render, keyboard exit passed",
      web: "TCP token, HTML, assets, server-info, workspace, WebSocket, shutdown passed",
      ...(socketPath
        ? { unixSocket: "HTTP, assets, server-info, WebSocket, cleanup passed" }
        : {}),
      isolated: true,
    }),
  );
} finally {
  terminal?.kill();
  web?.kill();
  await rm(directory, { recursive: true, force: true });
}

async function until(check, label, diagnostic) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(100);
  }
  throw new Error(`${label} timed out:\n${diagnostic()}`);
}

function requestOverSocket(socket, path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      {
        headers: { host: "localhost" },
        path,
        socketPath: socket,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolveRequest({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            statusCode: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on("error", rejectRequest);
    request.end();
  });
}
