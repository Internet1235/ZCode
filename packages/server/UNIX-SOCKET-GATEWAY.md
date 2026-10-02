# HTTP and Unix Socket Gateway

## Behavior

`createHttpServer` exposes the same HTTP routes, static files, and WebSocket routes through the configured TCP port and, optionally, a Unix domain socket. The TCP listener uses ZCode Token authentication when configured. The Unix Socket listener is the fnOS gateway entry and does not use ZCode Token authentication.

The TCP listener remains controlled by `PORT` and `ZCODE_SERVER_HOST`. The Unix listener is opt-in through `ZCODE_SERVER_SOCKET`. The packaged `zcode --web` command exposes the same option as `--socket`. The HTTP entry uses the explicitly configured `ZCODE_WEB_STATIC_ROOT`; the packaged runner supplies its Web directory as before.

Resource completeness is verified by gateway and distribution smoke tests rather than repeated HTML scans during packaging and startup. Gateway asset URLs must remain under the page base path; filesystem checks cannot correct a gateway routing mismatch.

## Ownership and invariants

## Gateway base path

The same release supports both `/` direct access and `/app/zcode/` gateway access. Both listeners redirect exactly `/app/zcode` to `/app/zcode/` with status `308`, preserving the query string, before authentication or page handling. The no-slash entry does not serve HTML. A gateway that strips the prefix must perform this redirect itself because the upstream cannot distinguish the original entry paths. The slash entry, nested paths, and direct root are not redirected. Bootstrap API and WebSocket URLs use the page base, never the gateway origin root.

Generated assets use relative URLs again: the canonical trailing-slash page resolves them under `/app/zcode/`, while direct root access resolves them under `/`. The fixed production asset prefix introduced to support the no-slash entry is removed, together with its HTML page-base and server homepage mapping branches. Acceptance covers the redirect, query preservation, canonical page, relative assets, API, and WebSocket routes.

Both listeners accept routes with or without the `/app/zcode` prefix, so a gateway may preserve or strip it. Prefix handling must not bypass TCP token checks. Static files retain the existing SPA fallback behavior. Acceptance covers prefixed HTML, every generated asset, API authentication, and WebSocket upgrade; direct root access remains compatible.

The server module owns both Node listeners and their route applications. The route registration and business services are shared, while authentication is listener-specific: TCP checks `?token=` or the `zcode_lite_token` cookie; the Unix Socket trusts access control performed by fnOS. The Unix Socket must not be writable by untrusted local users or processes.

The WebSocket injector is attached to both listeners before either listener accepts traffic. WebSocket clients use the existing `/ws`, `/ws/host`, and `/ws/remote/:id` routes.

## Failure and shutdown

Before binding, an existing filesystem socket is removed only when it is a socket. An existing regular file or directory is a startup error. If either listener fails to bind, the other listener is closed and startup fails.

`closeHttpServer` closes both listeners and removes the socket file. The HTTP entry handles `SIGINT` and `SIGTERM` so a normal service shutdown does not leave a stale socket path.

On `SIGINT` or `SIGTERM`, the HTTP entry first closes both listeners, then awaits the local service disposer. The disposer waits for every ZCode Agent process manager to complete graceful and forced process-tree cleanup before the server exits. A listener or service cleanup failure sets a non-zero process exit code while still allowing the remaining cleanup step to run. The packaged runner waits for the server to exit naturally; its 10-second timer only sends `SIGKILL` and reports failure when an abnormal shutdown does not complete.

## Migration boundary

Existing deployments that set only `PORT` keep the current TCP-only behavior. fnOS deployments set `ZCODE_SERVER_SOCKET` in addition to `PORT` and point the unified gateway at that socket. When a token is configured, it protects direct TCP access only; fnOS gateway requests do not need `?token=` or the ZCode cookie. The upstream service still listens on the local TCP port, so existing local health checks and direct access remain available.