import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { ServiceCollection } from "../packages/services/src/index.js";
import { closeHttpServer, createHttpServer } from "../packages/server/src/http.js";

const staticRoot = resolve("packages/web/dist");
const html = await readFile(resolve(staticRoot, "index.html"), "utf8");
const assets = [...html.matchAll(/(?:src|href)=["'](?:\/|\.\/)?(assets\/[^"']+)["']/g)].map(
  ([, asset]) => asset,
);
assert.ok(assets.length > 0);
const server = await createHttpServer(new ServiceCollection(), 0, {
  host: "127.0.0.1",
  staticRoot,
  authToken: "gateway-test",
  authRequired: true,
});
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const prefix of ["", "/app/zcode"]) {
    for (const path of [prefix || "/", `${prefix}/`]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /<html/i);
    }
    for (const asset of assets) {
      const response = await fetch(`${origin}${prefix}/${asset}`);
      assert.equal(response.status, 200, `${prefix}/${asset}`);
      assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/html/);
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${origin}${prefix}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${origin}${prefix}/api/server-info`)).status, 401);
    assert.equal(
      (await fetch(`${origin}${prefix}/api/server-info?token=gateway-test`)).status,
      200,
    );
    const denied = new WebSocket(`${origin.replace("http:", "ws:")}${prefix}/ws`);
    const deniedStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
      denied.once("unexpected-response", (_request, response) => {
        response.resume();
        denied.terminate();
        resolveStatus(response.statusCode ?? 0);
      });
      denied.once("error", rejectStatus);
    });
    assert.equal(deniedStatus, 401);
    const socket = new WebSocket(
      `${origin.replace("http:", "ws:")}${prefix}/ws?token=gateway-test`,
    );
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
  console.log(`gateway base-path passed: root/prefix HTML, ${assets.length} assets, API, WS, token, 404`);
} finally {
  await closeHttpServer(server);
}