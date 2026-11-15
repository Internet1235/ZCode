// RPC-LIFE01–03：生产 RPC 的隔离运行时验收，不接现有服务或业务数据库。
import assert from "node:assert/strict";
import {
  CancellationTokenSource,
  ChannelClient,
  ChannelServer,
  Emitter,
  Event,
  getDelayedChannel,
  Relay,
  toDisposable,
} from "../../../../rpc/src/index.ts";
import { BufferReader, deserialize } from "../../../../rpc/src/serialization.ts";
import { RequestType, ResponseType } from "../../../../rpc/src/channels.shared.ts";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function microtasks() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}
function decode(buffer) {
  const reader = new BufferReader(buffer);
  return { header: deserialize(reader), body: deserialize(reader) };
}
async function rpc(action, initialized = true) {
  const timers = new Map();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  // 仅替换本验收进程的计时器；按精确截止时间推进，不靠 sleep 猜测。
  globalThis.setTimeout = (callback, delay) => {
    const handle = {};
    timers.set(handle, { callback, delay });
    return handle;
  };
  globalThis.clearTimeout = (handle) => timers.delete(handle);
  const serverInput = new Emitter();
  const clientInput = new Emitter();
  const requests = [];
  const responses = [];
  const client = new ChannelClient({
    onMessage: clientInput.event,
    send(buffer) {
      requests.push(decode(buffer));
      serverInput.fire(buffer);
    },
  });
  const server = new ChannelServer(
    {
      onMessage: serverInput.event,
      send(buffer) {
        responses.push(decode(buffer));
        clientInput.fire(buffer);
      },
    },
    "isolated-rpc",
    40,
    true,
  );
  if (initialized) server.ready();
  const runTimers = (delay) => {
    const pendingTimers = [...timers];
    for (const [handle, timer] of pendingTimers) {
      if (timer.delay !== delay || !timers.delete(handle)) continue;
      timer.callback();
    }
  };
  try {
    await action({ client, server, requests, responses, timers, runTimers });
  } finally {
    client.dispose();
    server.dispose();
    serverInput.dispose();
    clientInput.dispose();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}
function counterChannel() {
  const events = new Emitter();
  const counts = { calls: 0, listens: 0, active: 0 };
  return {
    counts,
    events,
    channel: {
      async call() {
        counts.calls++;
        return "accepted";
      },
      listen() {
        return (listener) => {
          counts.listens++;
          counts.active++;
          const subscription = events.event(listener);
          return toDisposable(() => {
            counts.active--;
            subscription.dispose();
          });
        };
      },
    },
  };
}

const cases = [
  [
    "registered-and-before-deadline-controls",
    () =>
      rpc(async ({ client, server, runTimers }) => {
        const port = counterChannel();
        server.registerChannel("registered", port.channel);
        assert.equal(await client.getChannel("registered").call("command"), "accepted");
        const waiting = client.getChannel("later").call("command");
        server.registerChannel("later", port.channel);
        runTimers(0);
        assert.equal(await waiting, "accepted");
        assert.equal(port.counts.calls, 2);
      }),
  ],
  ...["cancel", "timeout", "dispose"].map((terminal) => [
    `pending-promise-${terminal}-does-not-revive`,
    () =>
      rpc(async ({ client, server, timers, runTimers }) => {
        const source = new CancellationTokenSource();
        const port = counterChannel();
        const rejected = assert.rejects(
          client.getChannel("late").call("command", null, source.token),
        );
        if (terminal === "cancel") source.cancel();
        else if (terminal === "timeout") runTimers(40);
        else {
          server.dispose();
          client.dispose();
        }
        await rejected;
        assert.equal(timers.size, 0, "terminal request must release its deadline");
        server.registerChannel("late", port.channel);
        runTimers(0);
        await microtasks();
        assert.equal(port.counts.calls, 0);
        source.dispose();
      }),
  ]),
  [
    "pending-unlisten-and-event-timeout",
    () =>
      rpc(async ({ client, server, responses, timers, runTimers }) => {
        const port = counterChannel();
        const event = client.getChannel("late-event").listen("changes");
        event(() => {}).dispose();
        assert.equal(timers.size, 0);
        server.registerChannel("late-event", port.channel);
        runTimers(0);
        assert.equal(port.counts.listens, 0);
        client.getChannel("missing-event").listen("changes")(() =>
          assert.fail("error is not an event"),
        );
        runTimers(40);
        assert.equal(
          responses.filter((frame) => frame.header[0] === ResponseType.EventError).length,
          1,
        );
        assert.equal(client.handlers.size, 0);
        assert.equal(timers.size, 0);
      }),
  ],
  [
    "registered-pending-last-cancel-releases-flush",
    () =>
      rpc(async ({ client, server, timers, runTimers }) => {
        const port = counterChannel();
        const source = new CancellationTokenSource();
        const rejected = assert.rejects(
          client.getChannel("registered-later").call("command", null, source.token),
        );
        server.registerChannel("registered-later", port.channel);
        source.cancel();
        await rejected;
        assert.equal(
          timers.size,
          0,
          "last terminal request must release the scheduled channel flush",
        );
        runTimers(0);
        assert.equal(port.counts.calls, 0);
        source.dispose();
      }),
  ],
  ...["cancel", "dispose"].map((terminal) => [
    `before-initialize-promise-${terminal}-releases-wait`,
    () =>
      rpc(async ({ client, server, requests }) => {
        const port = counterChannel();
        const source = new CancellationTokenSource();
        server.registerChannel("waiting-call", port.channel);
        const rejected = assert.rejects(
          client.getChannel("waiting-call").call("command", null, source.token),
        );
        if (terminal === "cancel") source.cancel();
        else client.dispose();
        await rejected;
        assert.equal(client._onDidInitialize.listeners.size, 0);
        assert.equal(client.activeRequests.size, 0);
        server.ready();
        await microtasks();
        assert.equal(port.counts.calls, 0);
        assert.equal(requests.length, 0);
        source.dispose();
      }, false),
  ]),
  [
    "active-cancel-and-dispose-drop-late-results",
    () =>
      rpc(async ({ client, server, responses }) => {
        const waiting = deferred();
        let token;
        server.registerChannel("active", {
          call(_context, _command, _args, cancellation) {
            token = cancellation;
            return waiting.promise;
          },
          listen: () => () => toDisposable(() => {}),
        });
        const source = new CancellationTokenSource();
        const rejected = assert.rejects(
          client.getChannel("active").call("command", null, source.token),
        );
        source.cancel();
        assert.equal(token.isCancellationRequested, true);
        await rejected;
        const frameCount = responses.length;
        waiting.resolve("too late");
        await microtasks();
        assert.equal(responses.length, frameCount);
        const afterDispose = deferred();
        server.registerChannel("dispose-active", {
          call: () => afterDispose.promise,
          listen: () => () => toDisposable(() => {}),
        });
        const disposed = assert.rejects(client.getChannel("dispose-active").call("command"));
        server.dispose();
        client.dispose();
        await disposed;
        afterDispose.resolve("too late");
        await microtasks();
        assert.equal(responses.length, frameCount);
        source.dispose();
      }),
  ],
  [
    "event-resubscribe-shares-consumers-and-rejects-old-frames",
    () =>
      rpc(async ({ client, server, requests }) => {
        const port = counterChannel();
        server.registerChannel("events", port.channel);
        const event = client.getChannel("events").listen("changes");
        const first = [],
          second = [];
        const a = event((value) => first.push(value));
        const b = event((value) => second.push(value));
        port.events.fire(1);
        a.dispose();
        port.events.fire(2);
        assert.equal(port.counts.active, 1);
        b.dispose();
        assert.equal(port.counts.active, 0);
        const oldId = requests.find((frame) => frame.header[0] === RequestType.EventListen)
          .header[1];
        const c = event((value) => first.push(value));
        const ids = requests
          .filter((frame) => frame.header[0] === RequestType.EventListen)
          .map((frame) => frame.header[1]);
        assert.equal(new Set(ids).size, 2);
        client.onResponse({ type: ResponseType.EventFire, id: oldId, data: "old generation" });
        port.events.fire(3);
        assert.deepEqual(first, [1, 3]);
        assert.deepEqual(second, [1, 2]);
        c.dispose();
        assert.equal(port.counts.active, 0);
        assert.equal(client.handlers.size, 0);
      }),
  ],
  ...["unlisten", "dispose"].map((terminal) => [
    `before-initialize-${terminal}-does-not-subscribe`,
    () =>
      rpc(async ({ client, server, requests }) => {
        const port = counterChannel();
        server.registerChannel("waiting-event", port.channel);
        const subscription = client.getChannel("waiting-event").listen("changes")(() => {});
        if (terminal === "dispose") client.dispose();
        else subscription.dispose();
        server.ready();
        await microtasks();
        assert.equal(port.counts.listens, 0);
        assert.equal(
          requests.filter((frame) => frame.header[0] === RequestType.EventListen).length,
          0,
        );
        assert.equal(client.handlers.size, 0);
        assert.equal(client.activeRequests.size, 0);
      }, false),
  ]),
  [
    "synchronous-first-event-can-dispose-connection",
    () =>
      rpc(async ({ client, server }) => {
        let delivered = 0,
          active = 0;
        server.registerChannel("sync", {
          call: async () => null,
          listen: () => (listener) => {
            active++;
            listener("first");
            return toDisposable(() => {
              active--;
            });
          },
        });
        client.getChannel("sync").listen("changes")(() => {
          delivered++;
          client.dispose();
        });
        assert.equal(delivered, 1);
        assert.equal(active, 0);
        assert.equal(server.activeRequests.size, 0);
      }),
  ],
  [
    "typed-call-and-event-errors-stay-separate",
    () =>
      rpc(async ({ client, server, responses }) => {
        server.registerChannel("faults", {
          call() {
            throw Object.assign(new Error("fixture failure"), {
              code: "fixture.code",
              retryable: true,
              profileId: "fixture-profile",
              details: { count: 1 },
            });
          },
          listen() {
            throw new Error("fixture subscription failure");
          },
        });
        await assert.rejects(client.getChannel("faults").call("command"), (error) => {
          assert.equal(error.code, "fixture.code");
          assert.equal(error.profileId, "fixture-profile");
          assert.deepEqual(error.details, { count: 1 });
          return true;
        });
        client.getChannel("faults").listen("changes")(() => assert.fail("error is not data"));
        assert.equal(
          responses.filter((frame) => frame.header[0] === ResponseType.EventError).length,
          1,
        );
        assert.equal(server.activeRequests.size, 0);
        assert.equal(client.handlers.size, 0);
      }),
  ],
  [
    "live-and-pre-cancelled-token",
    () =>
      rpc(async ({ client, server }) => {
        const port = counterChannel();
        server.registerChannel("token", port.channel);
        const source = new CancellationTokenSource();
        const token = source.token;
        let notifications = 0;
        token.onCancellationRequested(() => notifications++);
        source.cancel();
        source.cancel();
        assert.equal(token.isCancellationRequested, true);
        assert.equal(notifications, 1);
        await assert.rejects(client.getChannel("token").call("command", null, token), /Cancelled/);
        assert.equal(port.counts.calls, 0);
        const late = new CancellationTokenSource();
        late.cancel();
        assert.equal(late.token.isCancellationRequested, true);
        source.dispose();
        late.dispose();
      }),
  ],
  [
    "delayed-route-and-relay-are-consumer-owned",
    async () => {
      const port = counterChannel();
      const route = deferred();
      const event = getDelayedChannel(route.promise).listen("changes");
      event(() => {}).dispose();
      route.resolve(port.channel);
      await microtasks();
      assert.equal(port.counts.listens, 0);
      const delivered = [];
      const subscription = event((value) => delivered.push(value));
      port.events.fire("ready");
      assert.deepEqual(delivered, ["ready"]);
      subscription.dispose();
      assert.equal(port.counts.active, 0);
      const again = event((value) => delivered.push(value));
      port.events.fire("again");
      again.dispose();
      assert.deepEqual(delivered, ["ready", "again"]);
      const relay = new Relay();
      relay.dispose();
      relay.input = port.channel.listen("changes");
      relay.event(() => {});
      assert.equal(port.counts.active, 0);
      assert.equal(port.counts.listens, 2);
    },
  ],
  [
    "once-and-relay-synchronous-first-frame-release",
    async () => {
      let active = 0;
      const synchronous = (listener) => {
        active++;
        listener("first");
        listener("second");
        return toDisposable(() => {
          active--;
        });
      };
      const delivered = [];
      Event.once(synchronous)((value) => delivered.push(value));
      assert.deepEqual(delivered, ["first"]);
      assert.equal(active, 0);
      const relay = new Relay();
      relay.input = synchronous;
      relay.event(() => relay.dispose());
      assert.equal(active, 0);
      const replacement = new Emitter();
      const switching = new Relay();
      switching.input = synchronous;
      const values = [];
      const subscription = switching.event((value) => {
        values.push(value);
        switching.input = replacement.event;
      });
      replacement.fire("replacement");
      assert.deepEqual(
        values,
        ["first", "replacement"],
        "replaced synchronous input must lose delivery eligibility",
      );
      assert.equal(active, 0);
      subscription.dispose();
      switching.dispose();
      replacement.dispose();
    },
  ],
];
const results = [];
for (const [name, action] of cases) {
  try {
    await action();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
  }
}
console.log(JSON.stringify({ layer: "isolated-production-rpc", results }, null, 2));
assert.equal(
  results.filter((result) => !result.passed).length,
  0,
  "RPC lifecycle acceptance failures",
);
