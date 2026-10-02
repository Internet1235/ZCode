# HTTP and Unix Socket Gateway

## Behavior

`createHttpServer` exposes the same HTTP routes, static files, and WebSocket routes through the configured TCP port and, optionally, a Unix domain socket. The TCP listener uses ZCode Token authentication when configured. The Unix Socket listener is the fnOS gateway entry and does not use ZCode Token authentication.

The TCP listener remains controlled by `PORT` and `ZCODE_SERVER_HOST`. The Unix listener is opt-in through `ZCODE_SERVER_SOCKET`. The packaged `zcode --web` command exposes the same option as `--socket`. The HTTP entry uses `ZCODE_WEB_STATIC_ROOT` when set; otherwise a release package resolves the sibling `web` directory automatically.

The configured Web root must contain `index.html` and every generated file referenced by its `/assets/...` URLs. The HTTP entry rejects an incomplete configured root before binding either listener, so TCP and Unix Socket requests cannot expose a page whose browser assets are missing.

## Ownership and invariants

## Gateway base path

The same release supports both `/` direct access and `/app/zcode/` gateway access. The page selects its base URL before loading relative generated assets. Bootstrap API and WebSocket URLs use that same base, never the gateway origin root. `/app/zcode` without a trailing slash must also resolve assets under `/app/zcode/`.

Both listeners accept routes with or without the `/app/zcode` prefix, so a gateway may preserve or strip it. Prefix handling must not bypass TCP token checks or turn missing assets into SPA HTML. Acceptance covers prefixed HTML, every generated asset, API authentication, and WebSocket upgrade; direct root access remains compatible.

The server module owns both Node listeners and their route applications. The route registration and business services are shared, while authentication is listener-specific: TCP checks `?token=` or the `zcode_lite_token` cookie; the Unix Socket trusts access control performed by fnOS. The Unix Socket must not be writable by untrusted local users or processes.

The WebSocket injector is attached to both listeners before either listener accepts traffic. WebSocket clients use the existing `/ws`, `/ws/host`, and `/ws/remote/:id` routes.

## Failure and shutdown

Before binding, an existing filesystem socket is removed only when it is a socket. An existing regular file or directory is a startup error. If either listener fails to bind, the other listener is closed and startup fails.

`closeHttpServer` closes both listeners and removes the socket file. The HTTP entry handles `SIGINT` and `SIGTERM` so a normal service shutdown does not leave a stale socket path.

On `SIGINT` or `SIGTERM`, the HTTP entry first closes both listeners, then awaits the local service disposer. The disposer waits for every ZCode Agent process manager to complete graceful and forced process-tree cleanup before the server exits. A listener or service cleanup failure sets a non-zero process exit code while still allowing the remaining cleanup step to run. The packaged runner waits for the server to exit naturally; its 10-second timer only sends `SIGKILL` and reports failure when an abnormal shutdown does not complete.

## Migration boundary

Existing deployments that set only `PORT` keep the current TCP-only behavior. fnOS deployments set `ZCODE_SERVER_SOCKET` in addition to `PORT` and point the unified gateway at that socket. When a token is configured, it protects direct TCP access only; fnOS gateway requests do not need `?token=` or the ZCode cookie. The upstream service still listens on the local TCP port, so existing local health checks and direct access remain available.