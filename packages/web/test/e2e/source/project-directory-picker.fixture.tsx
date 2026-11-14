import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectViaWebSocket } from "@zcode/client";
import type { VirtualProject } from "../../../../ui/src/project-sidebar/contract.js";
import { isLocale } from "@zcode/shared";
import { ZCodeIntlProvider, useZCodeIntl } from "../../../../ui/src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../../../ui/src/hooks/useServices.js";
import {
  TabStoreProvider,
  useTabStore,
  useTabStoreApi,
} from "../../../../ui/src/store/TabStoreProvider.js";
import { isWorkspaceTab } from "../../../../ui/src/store/tabStore.js";
import { useZCodeSessionStore } from "../../../../ui/src/store/zcodeSessionStore.js";
import { useRootWorkspaceActions } from "../../../../ui/src/root/useRootWorkspaceActions.js";
import type { CreateTaskRequest } from "../../../../ui/src/app-shell/types.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readComposerWorkspaceScope,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
} from "../../../../ui/src/v4/composer/composerDraftStore.js";
import {
  consumeV4ComposerDraftAttachments,
  registerV4ComposerDraftReader,
} from "../../../../ui/src/v4/composer/composerDraftWorkspaceTransfer.js";
import { createWebPlatform } from "../../../src/platform/index.js";
import { ProjectCreation } from "../../../../ui/src/project-sidebar/ProjectCreation.js";
import "../../../../ui/src/styles.css";

const params = new URLSearchParams(location.search);
const wsUrl = params.get("ws");
const workspacePath = params.get("workspace");
const otherWorkspace = params.get("otherWorkspace");
if (!wsUrl || !workspacePath || !otherWorkspace)
  throw new Error("Picker fixture requires ws, workspace and otherWorkspace");
const workspace = workspacePath;
const alternateWorkspace = otherWorkspace;
const clientNamespace = "project-picker-regression";
const initialText = "SDP_DRAFT_KEEP";
const newerText = "SDP_NEWER_DRAFT_KEEP";
const taskGroupId = "picker-group";
const platform = createWebPlatform();
const noOp = () => undefined;
const noOpAsync = async () => undefined;
const requestedLocale = params.get("locale");
if (!isLocale(requestedLocale)) throw new Error("Picker fixture requires a supported locale");
const locale = requestedLocale;
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = theme === "dark" ? "dark theme-zai-dark" : "theme-zai-light";

let socket: WebSocket | undefined;
const services = await connectViaWebSocket(wsUrl, {
  onOpenSocket: (opened) => {
    socket = opened;
  },
});
addEventListener("pagehide", () => socket?.close(), { once: true });
if (!services.projectService || !services.remoteProjectService)
  throw new Error("Picker fixture requires project and remote project services");
const service = services.projectService;
const remoteService = services.remoteProjectService;
const [initialProjects, directory] = await Promise.all([
  service.readProjects(),
  remoteService.readDirectory(),
]);

function Setup() {
  const tabStoreApi = useTabStoreApi();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    tabStoreApi.getState().addTab(workspace, { workspacePurpose: "conversation" });
    useZCodeSessionStore.getState().startDraft(workspace, undefined, undefined, {
      projectId: null,
      taskGroupId,
    });
    const scope = resolveComposerScope(null, undefined, clientNamespace);
    const draft = { text: initialText, projectId: null, taskGroupId };
    rememberComposerWorkspaceScope(workspace, undefined, scope);
    persistV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, draft, scope);
    const file = new File(["project picker attachment"], "picker-attachment.txt", {
      type: "text/plain",
    });
    const dispose = registerV4ComposerDraftReader(workspace, () => ({
      draft,
      attachments: [
        {
          id: "picker-attachment",
          file,
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        },
      ],
    }));
    setReady(true);
    return dispose;
  }, [tabStoreApi]);
  return ready ? <Picker /> : null;
}

function Picker() {
  const { intl } = useZCodeIntl();
  const tabStoreApi = useTabStoreApi();
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const [open, setOpen] = useState(true);
  const [projects, setProjects] = useState<VirtualProject[]>(initialProjects);
  const [saved, setSaved] = useState(0);
  const [navigation, setNavigation] = useState({ started: 0, completed: 0, settled: 0, error: "" });
  const [, renderWorkspace] = useState(0);
  const [attachments, setAttachments] = useState<
    { filename: string; sizeBytes: number; isFile: boolean; text: string | null }[]
  >([]);
  useEffect(() => useZCodeSessionStore.subscribe(() => renderWorkspace((count) => count + 1)), []);
  const currentPath = activeWorkspacePath ?? workspace;
  const currentIdentity = activeWorkspaceIdentity ?? undefined;
  const draftState = useZCodeSessionStore
    .getState()
    .getWorkspaceState(currentPath, currentIdentity);
  const draftFocusVersion = draftState.draftFocusVersion;
  useEffect(() => {
    const incoming = consumeV4ComposerDraftAttachments(
      currentIdentity?.trim() || currentPath,
      draftFocusVersion,
    );
    if (!incoming) return;
    let current = true;
    void Promise.all(
      incoming.map(async (attachment) => ({
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
        isFile: attachment.file instanceof File,
        text: attachment.file ? await attachment.file.text() : null,
      })),
    ).then((received) => {
      if (current) setAttachments(received);
    });
    return () => {
      current = false;
    };
  }, [currentIdentity, currentPath, draftFocusVersion]);
  const { handleCreateTask } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab: tabStoreApi.getState().addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings: false,
    allowOpenWorkspace: true,
    preferDirectoryBrowser: true,
    refreshProviderState: noOpAsync,
    updateAppSettings: noOpAsync,
    setOAuthError: noOp,
    setUser: noOp,
  });
  const createTask = (request?: CreateTaskRequest) => {
    setNavigation((state) => ({ ...state, started: state.started + 1, error: "" }));
    void handleCreateTask({
      ...(typeof request === "string" ? { provider: request } : request),
      onComplete: () => setNavigation((state) => ({ ...state, completed: state.completed + 1 })),
      onError: (error) => setNavigation((state) => ({ ...state, error: String(error) })),
    }).then(() => setNavigation((state) => ({ ...state, settled: state.settled + 1 })));
  };
  const replaceDraft = (path: string) => {
    useZCodeSessionStore.getState().startDraft(path, undefined, undefined, {
      projectId: null,
      taskGroupId: null,
    });
    const scope = resolveComposerScope(null, undefined, clientNamespace);
    rememberComposerWorkspaceScope(path, undefined, scope);
    persistV4ComposerDraft(
      path,
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      { text: newerText, projectId: null, taskGroupId: null },
      scope,
    );
  };
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const scope = readComposerWorkspaceScope(currentPath, currentIdentity, clientNamespace);
  const snapshot = {
    ...navigation,
    activeTabId,
    workspacePath: currentPath,
    workspaceIdentity: currentIdentity ?? null,
    workspacePurpose: activeTab && isWorkspaceTab(activeTab) ? activeTab.workspacePurpose : null,
    tabCount: tabs.length,
    activeTaskId: draftState.activeTaskId,
    projectId: draftState.draftProjectId,
    taskGroupId: draftState.draftTaskGroupId,
    draftFocusVersion,
    draft: readV4ComposerDraft(currentPath, currentIdentity, V4_DRAFT_SCOPE_ROOT, scope),
    scope,
    attachments,
  };
  return (
    <main data-testid="picker-ready" className="min-h-screen bg-background text-foreground">
      <button data-testid="picker-open" onClick={() => setOpen(true)}>
        New project
      </button>
      <output data-testid="picker-saved">{saved}</output>
      <button data-testid="picker-new-task" onClick={() => createTask()}>
        New task
      </button>
      <button
        data-testid="picker-switch-tab"
        onClick={() => {
          tabStoreApi.getState().addTab(alternateWorkspace, { workspacePurpose: "conversation" });
          replaceDraft(alternateWorkspace);
        }}
      >
        Switch workspace
      </button>
      <button data-testid="picker-replace-draft" onClick={() => replaceDraft(currentPath)}>
        Replace draft
      </button>
      <output data-testid="picker-navigation-state">{JSON.stringify(snapshot)}</output>
      {!open ? <output data-testid="picker-closed">Closed</output> : null}
      {open ? (
        <ProjectCreation
          workspacePath={currentPath}
          workspaceIdentity={currentIdentity}
          projects={projects}
          directory={directory}
          service={service}
          remoteService={remoteService}
          defaultDeviceId="local"
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setProjects(await service.readProjects());
            setSaved((count) => count + 1);
          }}
          onCreateTask={createTask}
        />
      ) : null}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Picker fixture root is missing");
createRoot(root).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <ServiceProvider services={services} composerClientNamespace={clientNamespace}>
      <TabStoreProvider>
        <Setup />
      </TabStoreProvider>
    </ServiceProvider>
  </ZCodeIntlProvider>,
);
