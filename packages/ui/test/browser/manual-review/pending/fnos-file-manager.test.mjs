import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright-core";

test("fnOS SDK routes original directory paths and rejects standalone browsers", async (t) => {
  const bundle = await build({
    entryPoints: ["packages/web/src/platform/fnosFileManager.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "fnosAdapter",
    platform: "browser",
  });
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || "msedge",
    headless: true,
  });
  t.after(() => browser.close());
  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Linux; Android 13) FNAppVer/1.34.0",
    });
    await page.evaluate(() => {
      window.calls = [];
      window.flutter_inappwebview = {
        _platformReady: true,
        callHandler: async (method, ...args) => {
          window.calls.push({ method, args });
          if (method === "getAppMessage") {
            return JSON.stringify({ result: JSON.stringify({ appApi: "1.34.0" }) });
          }
          if (window.rejectRoute) throw new Error("permission denied");
          return JSON.stringify({ result: "null" });
        },
      };
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    for (const path of [
      "/vol1/1000/中文 项目/#100%",
      "/vol1/project/.worktrees/branch",
      "/vol1/drafts/task",
    ]) {
      const result = await page.evaluate(
        (value) => window.fnosAdapter.openFnOSFileManager(value),
        path,
      );
      assert.deepEqual(result, { success: true });
      const calls = await page.evaluate(() =>
        window.calls.filter((call) => call.method === "openFileManager"),
      );
      assert.deepEqual(calls.at(-1).args, [path]);
    }
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((call) => call.method === "openFileManager").length,
      ),
      3,
    );
    await page.evaluate(() => {
      window.rejectRoute = true;
    });
    const rejected = await page.evaluate(() =>
      window.fnosAdapter.openFnOSFileManager("/vol1/denied"),
    );
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /permission denied/);
    const standalone = await browser.newPage();
    await standalone.addScriptTag({ content: bundle.outputFiles[0].text });
    const unsupported = await standalone.evaluate(() =>
      window.fnosAdapter.openFnOSFileManager("/vol1/project"),
    );
    assert.equal(unsupported.success, false);
    assert.match(unsupported.error, /fnOS/);
  } finally {
    await browser.close();
  }
});
