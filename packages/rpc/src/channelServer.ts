import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

interface ChannelRequest {
  type: RequestType.Promise | RequestType.EventListen;
  id: number;
  channelName: string;
  name: string;
  arg: unknown;
}

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private isDisposed = false;
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<
    number,
    { request: ChannelRequest; timer: ReturnType<typeof setTimeout> }
  >();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private protocolListener: IDisposable | null;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    if (this.isDisposed) return;
    this.channels.set(channelName, channel);
    if (
      !this.flushTimers.has(channelName) &&
      [...this.pendingRequests.values()].some((item) => item.request.channelName === channelName)
    ) {
      this.flushTimers.set(
        channelName,
        setTimeout(() => {
          this.flushTimers.delete(channelName);
          this.flushPendingRequests(channelName);
        }, 0),
      );
    }
  }

  private sendResponse(response: IRawResponse): void {
    if (this.isDisposed) return;
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.EventError:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onRawMessage(message: VSBuffer): void {
    if (this.isDisposed) return;
    // 修复原因：同一 protocol 上还有反向 ChannelClient，对方发来的响应也会到这里；原来先解码消息体
    // 再判断类型，每条响应都被完整解码两次。修法：先读消息头，只解码属于本端的请求体。
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const type = header[0] as RequestType;

    switch (type) {
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  private onPromise(request: ChannelRequest): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    const disposable = toDisposable(() => {
      cts.cancel();
      cts.dispose();
    });
    this.activeRequests.set(request.id, disposable);
    const isCurrent = () => this.activeRequests.get(request.id) === disposable && !this.isDisposed;
    let promise: Promise<any>;

    try {
      promise = Promise.resolve(channel.call(this.ctx, request.name, request.arg, cts.token));
    } catch (error) {
      promise = Promise.reject(error);
    }

    promise
      .then(
        (data) => {
          if (!isCurrent()) return;
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          if (!isCurrent()) return;
          if (error instanceof Error) {
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
              retryable?: unknown;
              profileId?: unknown;
            } = {
              message: error.message,
              name: error.name,
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            const errorRecord = error as Error & Record<string, unknown>;
            const passthroughKeys = [
              "code",
              "kind",
              "status",
              "retryAfterMs",
              "data",
              "detail",
              "details",
              "taskId",
              "traceId",
              "retryable",
              // Bug 原因：Host 的远程等待点（需要安装/升级、补凭据）用 profileId 指明实际操作线路；
              // 旧白名单丢掉它，侧栏项目只能把不含凭据的目标交给向导，确认安装后报“SSH 认证失败”。
              "profileId",
            ] as const;
            for (const key of passthroughKeys) {
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      .finally(() => {
        if (isCurrent()) this.disposeActiveRequest(request.id);
      });
  }

  private onEventListen(request: ChannelRequest): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    let subscription: IDisposable | undefined;
    const owner = toDisposable(() => subscription?.dispose());
    // 先登记 owner，同步首帧中的退订不能遗失尚未返回的上游 disposable。
    this.activeRequests.set(request.id, owner);
    const isCurrent = () => this.activeRequests.get(request.id) === owner && !this.isDisposed;
    try {
      subscription = channel.listen(
        this.ctx,
        request.name,
        request.arg,
      )((data) => {
        if (!isCurrent()) return;
        this.sendResponse({
          id: request.id,
          data,
          type: ResponseType.EventFire,
        });
      });
      if (!isCurrent()) subscription.dispose();
    } catch (error) {
      if (!isCurrent()) return;
      this.disposeActiveRequest(request.id);
      // 已结束的终端等资源会拒绝迟到订阅；该拒绝属于本次请求，不能逃逸并退出整个 Host。
      // 独立失败帧不会被旧客户端当作业务事件，也不会建立无法释放的活动订阅。
      this.sendResponse({
        id: request.id,
        type: ResponseType.EventError,
        data: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack.split("\n") } : {}),
        },
      });
    }
  }

  private disposeActiveRequest(id: number): void {
    this.removePendingRequest(id);
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    this.activeRequests.delete(id);
    disposable.dispose();
  }

  private collectPendingRequest(request: ChannelRequest): void {
    // 等待注册也由请求 ID 持有，超时/取消/退订均移除，迟到注册不能重新执行。
    const timer = setTimeout(() => {
      if (this.pendingRequests.get(request.id)?.request !== request || this.isDisposed) return;
      this.removePendingRequest(request.id);
      console.error(`Unknown channel: ${request.channelName}`);
      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type:
          request.type === RequestType.Promise
            ? ResponseType.PromiseError
            : ResponseType.EventError,
      });
    }, this.timeoutDelay);

    this.pendingRequests.set(request.id, { request, timer });
  }

  private removePendingRequest(id: number): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    const channelName = pending.request.channelName;
    // 最后一项可能在注册后的 flush 执行前取消；终态同时释放该 channel 的空扫描。
    if (
      ![...this.pendingRequests.values()].some((item) => item.request.channelName === channelName)
    ) {
      const flushTimer = this.flushTimers.get(channelName);
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      this.flushTimers.delete(channelName);
    }
  }

  private flushPendingRequests(channelName: string): void {
    if (this.isDisposed) return;
    // 固定本轮请求集合，重入中新收集的请求不能被同一轮 flush 提前执行。
    const pendingRequests = [...this.pendingRequests];
    for (const [id, pending] of pendingRequests) {
      const { request } = pending;
      if (request.channelName !== channelName || this.pendingRequests.get(id) !== pending) continue;
      this.removePendingRequest(id);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const timer of this.flushTimers.values()) clearTimeout(timer);
    this.flushTimers.clear();
    for (const id of this.pendingRequests.keys()) this.removePendingRequest(id);
    for (const id of this.activeRequests.keys()) this.disposeActiveRequest(id);
    this.channels.clear();
  }
}
