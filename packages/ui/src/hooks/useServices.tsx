/**
 * useServices —— 通过 React Context 提供 IServiceAccessor
 *
 * 替代 props drilling，组件通过 useServices() 直接获取服务。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";

const ServiceContext = createContext<IServiceAccessor | null>(null);
const ComposerClientNamespaceContext = createContext("desktop");
const TerminalOwnerContext = createContext<string | undefined>(undefined);
const DirectSourceHostContext = createContext<string | undefined>(undefined);

/** 普通 Web 的根连接身份只用于选路，服务端仍独立校验调用准入。 */
export function useDirectSourceHostId(): string | undefined {
  return useContext(DirectSourceHostContext);
}

export function isDirectSourceWorkspace(
  identity: string | null | undefined,
  hostId: string | undefined,
): boolean {
  return Boolean(hostId && identity && remoteHostIdFromWorkspaceIdentity(identity) === hostId);
}

export function useTerminalOwnerId(): string | undefined {
  return useContext(TerminalOwnerContext);
}

/** 手机同源可连接多台桌面；稳定设备身份不能用临时 bridge ID 替代。 */
export function useComposerClientNamespace(): string {
  return useContext(ComposerClientNamespaceContext);
}

export function ServiceProvider({
  services,
  children,
  composerClientNamespace,
  terminalOwnerId,
  directSourceHostId,
}: {
  services: IServiceAccessor;
  children: ReactNode;
  composerClientNamespace?: string;
  terminalOwnerId?: string;
  directSourceHostId?: string;
}) {
  const inheritedNamespace = useComposerClientNamespace();
  const inheritedTerminalOwner = useTerminalOwnerId();
  const inheritedSourceHost = useDirectSourceHostId();
  return (
    <ComposerClientNamespaceContext.Provider value={composerClientNamespace ?? inheritedNamespace}>
      <TerminalOwnerContext.Provider value={terminalOwnerId ?? inheritedTerminalOwner}>
        <DirectSourceHostContext.Provider value={directSourceHostId ?? inheritedSourceHost}>
          <ServiceContext.Provider value={services}>{children}</ServiceContext.Provider>
        </DirectSourceHostContext.Provider>
      </TerminalOwnerContext.Provider>
    </ComposerClientNamespaceContext.Provider>
  );
}

export function useServices(): IServiceAccessor {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error("useServices 必须在 ServiceProvider 内使用");
  }
  return ctx;
}

export function useOptionalServices(): IServiceAccessor | null {
  return useContext(ServiceContext);
}
