// SDP01–03：真实创建表单、普通 /ws、项目服务、文件 IO 与隔离 SQLite。
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNodeHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { connectViaWebSocket } from "@zcode/client";
import { ServiceCollection } from "../../../../services/src/collection.ts";
import { TaskIndexRepo } from "../../../../services/src/session/taskIndexRepo.ts";
import { createProjectService, IProjectService } from "../../../../services/src/project/index.ts";
import { createRemoteProjectService } from "../../../../services/src/remote-projects/index.ts";
import { IRemoteProjectService } from "../../../../services/src/remote-projects/contract.ts";
import { createFileService } from "../../../../services/src/file/fileService.ts";
import { createHttpServer, closeHttpServer } from "../../../../server/src/http.ts";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "zcode-project-picker-"));
const sourceHome = join(root, "source-home");
const localHome = join(root, "local-home");
const sourcePath = join(sourceHome, "allowed-workspace");
const localPath = join(localHome, "allowed-workspace");
const sourceServerId = "project-picker-source";
const sourceHostId = remoteHostIdFromWorkspaceIdentity(
  buildServerRemoteWorkspaceIdentity({
    serverId: sourceServerId,
    workspacePath: sourcePath,
  }),
);
assert.ok(sourceHostId && sourceHostId !== "local");
const sourceIndex = new TaskIndexRepo(undefined, sourceHostId, join(root, "source.sqlite"));
const localIndex = new TaskIndexRepo(undefined, "local", join(root, "local.sqlite"));
const servers = [];
const sockets = new Set();
const calls = [];
const io = [];
let vite;
let browser;
let uiServer;
let uiUrl;
let rejectNextEntry = false;

function trace(owner, service) {
  return Object.fromEntries(
    Object.entries(service).map(([method, implementation]) => [
      method,
      async (...args) => {
        const call = { owner, method, args };
        calls.push(call);
        try {
          if (owner === "local" && method === "addEntry" && rejectNextEntry) {
            rejectNextEntry = false;
            throw new Error("project.connection-unavailable");
          }
          return await implementation(...args);
        } catch (error) {
          call.error = String(error);
          throw error;
        }
      },
    ]),
  );
}

function directories(owner, home) {
  const files = createFileService();
  return {
    home: async () => home,
    read: async (params) => {
      io.push({ owner, ...params });
      return files.readdir(params);
    },
  };
}

async function listen(project, remote, serverId, workspace) {
  const services = new ServiceCollection()
    .register(IProjectService, project)
    .register(IRemoteProjectService, remote);
  const server = await createHttpServer(services, 0, {
    host: "127.0.0.1",
    authToken: "",
    authRequired: false,
    serverId,
    virtualProjects: true,
    workspaces: [{ path: workspace, label: "Picker fixture" }],
  });
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/api/server-info`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).serverId, serverId);
  return url;
}

async function navigate(panel, path) {
  await panel.getByRole("textbox").fill(path);
  await panel.getByRole("textbox").press("Enter");
  await panel.getByRole("button", { name: "visible-child", exact: true }).waitFor();
  assert.equal(await panel.getByRole("textbox").inputValue(), path);
  assert.equal(await panel.getByTestId("directory-browser-confirm").isEnabled(), true);
}

async function browse(page, home, path) {
  await page.getByTestId("virtual-project-browse").click();
  const panel = page.getByTestId("virtual-project-directory-browser");
  await panel.getByRole("button", { name: basename(path), exact: true }).waitFor();
  assert.equal(await panel.getByRole("textbox").inputValue(), home);
  const bounds = await panel.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && viewport);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
  return panel;
}

async function runPicker({
  url,
  home,
  path,
  owner,
  locale,
  theme,
  width,
  external = false,
  retryEntry = false,
}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const errors = [];
  const consoleErrors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(60_000);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await context.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  const ws = url.replace("http:", "ws:") + "/ws";
  const query = new URLSearchParams({ ws, workspace: path, locale, theme });
  const start = calls.length;
  const countProjects = async () =>
    (await (owner === "source" ? sourceIndex : localIndex).getProjectRepository()).readTree()
      .projects.length;
  const before = await countProjects();
  const cancel = locale === "en-US" ? "Cancel" : "取消";
  const name = `SDP-${external ? "external" : owner}-${width}-${theme}-${locale}`;
  try {
    await page.goto(`${uiUrl}/?${query}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("picker-ready").waitFor({ timeout: 60_000 });
    if (external) {
      await page.getByTestId("virtual-project-device").click();
      await page.locator(`[data-device-id="${sourceHostId}"]`).click();
    }
    await page.getByTestId("virtual-project-name").fill(name);
    let panel = await browse(page, home, path);
    await panel.getByRole("button", { name: cancel, exact: true }).click();
    assert.equal(await page.getByTestId("virtual-project-root-row").count(), 0);
    assert.equal(await countProjects(), before, "Cancelling directory selection must not save");

    panel = await browse(page, home, path);
    if (!external && owner === "source") {
      const missing = join(home, "missing-directory");
      await panel.getByRole("textbox").fill(missing);
      await panel.getByRole("textbox").press("Enter");
      await panel.locator(".text-destructive").waitFor();
      assert.equal(await panel.getByTestId("directory-browser-confirm").isDisabled(), true);
    }
    await navigate(panel, path);
    if (
      process.env.PROJECT_PICKER_ARTIFACTS &&
      !external &&
      owner === "source" &&
      locale === "zh-CN" &&
      ((width === 1024 && theme === "light") || (width === 390 && theme === "dark"))
    ) {
      await mkdir(process.env.PROJECT_PICKER_ARTIFACTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.PROJECT_PICKER_ARTIFACTS, `${name}.png`),
      });
    }
    await panel.getByTestId("directory-browser-confirm").click();
    assert.equal(await page.getByTestId("virtual-project-root-row").count(), 1);
    assert.equal(await page.getByTestId("virtual-project-root-name").getAttribute("title"), path);
    assert.equal(await countProjects(), before, "Selecting a root must only update the draft");

    await page.getByTestId("virtual-project-save").click();
    await page.getByTestId("project-folder-trust-dialog").waitFor();
    await page.getByTestId("project-folder-trust-cancel").click();
    assert.equal(await countProjects(), before, "Cancelling trust must not save");
    assert.equal(calls.slice(start).filter((call) => call.method === "saveProject").length, 0);
    await page.getByTestId("virtual-project-save").click();
    if (retryEntry) rejectNextEntry = true;
    await page.getByTestId("project-folder-trust-confirm").click();
    if (retryEntry) {
      await page.getByRole("alert").waitFor();
      assert.equal(await countProjects(), before + 1);
      assert.equal(await page.getByTestId("virtual-project-name").isDisabled(), true);
      assert.equal(await page.getByTestId("virtual-project-device").isDisabled(), true);
      await page.getByTestId("virtual-project-save").click();
    }
    await page.getByTestId("picker-closed").waitFor();
    assert.equal(await page.getByTestId("picker-saved").textContent(), "1");
    assert.equal(await countProjects(), before + 1);
    const repository = await (owner === "source" ? sourceIndex : localIndex).getProjectRepository();
    const saved = repository.readTree().projects.find((project) => project.name === name);
    assert.ok(saved);
    assert.equal(saved.hostId, owner === "source" ? sourceHostId : "local");
    assert.deepEqual(
      saved.roots.map((root) => root.rootPath),
      [path],
    );
    const traffic = calls.slice(start);
    const target = external ? sourceHostId : undefined;
    const requestOwner = external ? "local" : owner;
    const directoryCalls = traffic.filter(
      (call) => call.owner === requestOwner && call.method === "readDirectory" && call.args[0],
    );
    assert.ok(directoryCalls.some((call) => call.args[0].path === path));
    assert.ok(directoryCalls.every((call) => call.args[0].hostId === target));
    const saves = traffic.filter(
      (call) => call.owner === requestOwner && call.method === "saveProject",
    );
    assert.equal(saves.length, 1);
    assert.equal(saves[0].args[0].hostId, target);
    const entries = traffic.filter((call) => call.method === "addEntry");
    assert.equal(entries.length, external ? (retryEntry ? 2 : 1) : 0);
    if (external) {
      for (const entry of entries) {
        assert.equal(entry.args[0].hostId, sourceHostId);
        assert.equal(entry.args[0].project.projectId, saved.id);
        assert.ok(entry.args[0].expectedMembershipId);
      }
      if (retryEntry) assert.match(entries[0].error, /project\.connection-unavailable/);
      assert.equal(entries.at(-1).error, undefined);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error("Picker page errors:", JSON.stringify({ errors, consoleErrors }));
    console.error("Picker traffic on failure:", JSON.stringify(calls.slice(start), null, 2));
    throw error;
  } finally {
    await context.close();
  }
}

try {
  await Promise.all(
    [sourcePath, localPath].map(async (path) => {
      await mkdir(join(path, "visible-child"), { recursive: true });
      await writeFile(join(path, "not-a-directory.txt"), "picker fixture");
    }),
  );
  const sourceProject = trace(
    "source",
    createProjectService({
      repository: () => sourceIndex.getProjectRepository(),
      workspaceDirectory: sourceHome,
      ownerHostId: sourceHostId,
      directories: directories("source", sourceHome),
    }),
  );
  const sourceRemote = trace(
    "source",
    createRemoteProjectService({
      database: () => sourceIndex.getOrganizationDatabase(),
      controller: false,
    }),
  );
  const sourceUrl = await listen(sourceProject, sourceRemote, sourceServerId, sourcePath);
  const localProject = trace(
    "local",
    createProjectService({
      repository: () => localIndex.getProjectRepository(),
      workspaceDirectory: localHome,
      directories: directories("local", localHome),
      resolveHost: async (id) => {
        assert.equal(id, sourceHostId);
        return sourceProject;
      },
    }),
  );
  const localRemote = trace(
    "local",
    createRemoteProjectService({
      database: () => localIndex.getOrganizationDatabase(),
      readConnectionStates: async () => new Map([[sourceHostId, { connectionStatus: "online" }]]),
    }),
  );
  await localRemote.saveHost({
    id: sourceHostId,
    target: { kind: "server", serverId: sourceServerId, url: sourceUrl },
  });
  const localUrl = await listen(localProject, localRemote, "project-picker-local", localPath);
  const client = await connectViaWebSocket(sourceUrl.replace("http:", "ws:") + "/ws", {
    onOpenSocket: (socket) => sockets.add(socket),
  });
  const beforeIO = io.length;
  await assert.rejects(
    client.projectService.readDirectory({ hostId: "local", path: sourcePath }),
    /project\.host-offline/,
  );
  assert.equal(io.length, beforeIO, "Wrong explicit Host must fail before filesystem IO");
  assert.equal((await client.projectService.readDirectory({ path: sourcePath })).path, sourcePath);
  console.log("PASS SDP03 explicit Host guard over ordinary /ws");

  vite = await createServer({
    configFile: false,
    envFile: false,
    root: resolve(repoRoot, "packages", "web"),
    cacheDir: join(root, "vite-cache"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "project-picker-fixture",
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (new URL(request.url, "http://127.0.0.1").pathname !== "/") return next();
            try {
              const html = await server.transformIndexHtml(
                request.url,
                '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/e2e/source/project-directory-picker.fixture.tsx"></script></body></html>',
              );
              response.setHeader("Content-Type", "text/html");
              response.end(html);
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
    resolve: {
      alias: [
        { find: "@", replacement: resolve(repoRoot, "packages", "ui", "src") },
        {
          find: "d3-path",
          replacement: resolve(repoRoot, "node_modules", "d3-path", "src", "index.js"),
        },
      ],
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify("3.18.0"),
      __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify("3.15.0"),
      __ZCODE_COMMIT__: JSON.stringify("picker-e2e"),
      __ZCODE_ENV__: JSON.stringify("test"),
    },
    optimizeDeps: {
      entries: ["test/e2e/source/project-directory-picker.fixture.tsx"],
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
      exclude: ["pdfjs-dist"],
    },
    server: { middlewareMode: true, hmr: false, fs: { allow: [repoRoot] } },
  });
  uiServer = createNodeHttpServer(vite.middlewares);
  uiServer.listen(0, "127.0.0.1");
  await once(uiServer, "listening");
  const address = uiServer.address();
  assert.ok(address && typeof address === "object");
  uiUrl = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(uiUrl)).status, 200);
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ?? "chrome",
    headless: true,
  });
  for (const width of [1024, 390]) {
    for (const theme of ["light", "dark"]) {
      for (const locale of ["zh-CN", "en-US"]) {
        await runPicker({
          url: sourceUrl,
          home: sourceHome,
          path: sourcePath,
          owner: "source",
          width,
          theme,
          locale,
        });
      }
    }
  }
  await runPicker({
    url: localUrl,
    home: localHome,
    path: localPath,
    owner: "local",
    width: 1024,
    theme: "light",
    locale: "en-US",
  });
  await runPicker({
    url: localUrl,
    home: sourceHome,
    path: sourcePath,
    owner: "source",
    external: true,
    retryEntry: true,
    width: 390,
    theme: "dark",
    locale: "zh-CN",
  });
  console.log(
    "PASS SDP01–03: current Source, local owner, explicit external Host, and real IO errors",
  );
} finally {
  await browser?.close();
  for (const socket of sockets) socket.close();
  await Promise.all([
    vite?.close(),
    uiServer && closeHttpServer(uiServer),
    ...servers.map(closeHttpServer),
  ]);
  sourceIndex.close({ throwOnError: true });
  localIndex.close({ throwOnError: true });
  await rm(root, { recursive: true, force: true });
}
