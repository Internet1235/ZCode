# RPC Channel 初始化时序与 "Unknown channel" 问题

## 问题现象

Remote 模式下，窗口打开时报错：

```
[DirectoryBrowser] 获取系统信息失败: Unknown channel: Channel name 'system'
timed out after 1000ms
```

## ChannelClient 状态迁移

```
Uninitialized ──[收到 Initialize(200)]──→ Idle ──[发送请求]──→ Idle（保持）
```

- **Uninitialized**：还没收到服务端 Initialize，请求等待就绪；取消、最后退订和连接 dispose 仍立即撤销发送资格，不等待 Initialize
- **Idle**：已收到 Initialize，请求立即发出

## 完整通信流程

### Local 模式（正常）

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer()
                                  ├── 立即发 Initialize ──────────→ 收到 Initialize
                                  ├── state → Idle                   ChannelClient: Uninitialized → Idle
                                  │
                                  createLocalServices()  (同步)
                                  exposeOnChannelServer()  (同步)
                                  注册 file/system/terminal/...
                                                                     DirectoryBrowser mounts
                                                                     useEffect → systemService.info()
                                                                     RPC 请求发出 ← ─ ─ ─ ─ ─ ─ ─ ─ ─
                                                                  ← ─ system channel 已注册，直接处理
                                                                     返回结果 ──────────────────────→
```

**没问题**：`Initialize` 发完后，`registerChannel` 马上同步执行。Renderer 收到 `Initialize` 发请求时，channel 已经注册好了。

### Remote 模式（有 bug）

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer()
                                  ├── 立即发 Initialize ──────────→ 收到 Initialize
                                  │                                 ChannelClient: Uninitialized → Idle
                                  │
                                  await setupRemoteConnection()     DirectoryBrowser mounts
                                    (SSH 建连，可能 2~5 秒)        useEffect → systemService.info()
                                  │                                 RPC 请求发出 ─ ─ ─ ─ ─ ─ ─ ─ ─ →
                                  │                                 system channel 不存在！
                                  │                                 进入 pendingRequests 队列
                                  │                                 设 1000ms 超时定时器
                                  │
                                  │                                 ─── 1000ms 后 ───
                                  │                                 超时！报错:
                                  │                                 "Unknown channel: 'system'"
                                  │
                                  ... SSH 还在连接中 ...
                                  │
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)    ← 太晚了，请求已超时
```

**根因**：`ChannelServer` 构造时就发了 `Initialize`，renderer 以为服务端已就绪，立即发请求。但 SSH 还没连完，`system` channel 还没注册，1000ms 超时。

### 修复后的 Remote 模式

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer(deferInit=true)
                                  ├── 不发 Initialize
                                  │                                 ChannelClient: 保持 Uninitialized
                                  │
                                  await setupRemoteConnection()
                                    (SSH 建连，可能 2~5 秒)        DirectoryBrowser mounts
                                  │                                 useEffect → systemService.info()
                                  │                                 ChannelClient 还在 Uninitialized
                                  │                                 请求自动排队等 Initialize（不会超时）
                                  │
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)
                                  server.ready() ─── 发 Initialize → 收到 Initialize
                                                                     ChannelClient: Uninitialized → Idle
                                                                     排队的请求立即发出 ─ ─ ─ ─ ─ → system channel 已注册，直接处理
                                                                  ← ─ 返回结果 ──────────────────→
```

## 修复方案

给 `ChannelServer` 加 `deferInit` 选项：

- **Local 模式**：构造时立即发 `Initialize`（行为不变）
- **Remote 模式**：构造时不发 `Initialize`，等 `registerChannel` 全部完成后调 `server.ready()` 手动发送

涉及文件：

- `packages/rpc/src/channelServer.ts` — `deferInit` 和 `ready()`；等待注册的请求在超时/取消/退订/dispose 后彻底移除
- `packages/rpc/src/channelClient.ts` — 初始化前可撤销请求；每轮事件订阅使用独立 ID，迟到 Initialize 不复活旧订阅
- `packages/rpc/src/logging-middleware.ts` — `LoggingChannelServer` 透传 `ready()`
- `packages/desktop/src/host/index.ts` — remote 模式传 `deferInit=true`，服务注册后调 `server.ready()`

Initialize 表示该连接已完成装配，不表示任意惰性 proxy 对应的 channel 存在。
窗口 Controller 必须在连接装配时显式声明能力：Desktop base/scoped attachment 和手机 shared-host
提供，普通 Source WebSocket 与 Source settings scope 不提供；缺席使用既有 TaskService 路径，
不能捕获 Unknown channel 后改投另一 owner。不得以延长超时替代正确就绪和生命周期管理。
