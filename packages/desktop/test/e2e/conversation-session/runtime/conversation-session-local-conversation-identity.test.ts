import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildServerRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_COMPOSER_PROJECT_DETACH,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";

const CASE_MARKER = "E2E_LOCAL_CONVERSATION_IDENTITY";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/local-conversation-identity",
);

interface NavigationTab {
  id: string;
  kind: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: string;
  remoteSessionId?: string;
}

interface NavigationWindow extends Window {
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(
        workspacePath: string,
        workspaceIdentity?: string,
      ): { draftProjectId?: string | null };
    };
  };
  __zcodeTabStoreE2E?: {
    getState(): {
      tabs: NavigationTab[];
      activeTabId: string | null;
      activeWorkspacePath: string | null;
      activeWorkspaceIdentity: string | null;
      addTab(
        path: string,
        options: { workspaceIdentity: string; remoteTarget: RemoteTarget },
      ): string;
      activateTab(id: string): void;
    };
  };
}

async function readNavigation() {
  return browser.execute(() => {
    const state = (window as NavigationWindow).__zcodeTabStoreE2E?.getState();
    if (!state) throw new Error("导航 store 未就绪");
    return {
      activeTabId: state.activeTabId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      tabs: state.tabs.map((tab) => ({
        id: tab.id,
        workspacePath: tab.workspacePath ?? null,
        workspaceIdentity: tab.workspaceIdentity ?? null,
        workspacePurpose: tab.workspacePurpose ?? null,
        remoteSessionId: tab.remoteSessionId ?? null,
      })),
    };
  });
}

async function readDraftProjectId() {
  return browser.execute(() => {
    const navigation = (window as NavigationWindow).__zcodeTabStoreE2E?.getState();
    const sessions = (window as NavigationWindow).__zcodeSessionStoreE2E;
    if (!navigation?.activeWorkspacePath || !sessions) throw new Error("草稿 store 未就绪");
    return sessions
      .getState()
      .getWorkspaceState(
        navigation.activeWorkspacePath,
        navigation.activeWorkspaceIdentity ?? undefined,
      ).draftProjectId;
  });
}

describe(`${CASE_MARKER}: 本地项目解除绑定按完整工作区身份匹配`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    facts.final = await readNavigation();
    await writeFile(
      resolve(artifactDir, "local-conversation-identity.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.saveScreenshot(resolve(artifactDir, "local-conversation-identity.png"));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RPN-12 本地项目与离线远端同路径且远端在前，仍能在项目外工作", async function () {
    this.timeout(60_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    const projectName = "E2E_DETACH_EXISTING_PROJECT";
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue(projectName);
    await $('[data-testid="virtual-project-save"]').click();
    await $(`[data-project-name="${projectName}"]`).waitForExist();
    await $('[data-slot="dialog-overlay"]').waitForExist({ reverse: true });
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="composer-project-menu"] [data-project-name="${projectName}"]`).click();
    await browser.waitUntil(async () =>
      (await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).includes(
        projectName,
      ),
    );
    expect(await readDraftProjectId()).toBeTruthy();
    const selectedProject = await readNavigation();
    const projectPath = selectedProject.activeWorkspacePath;
    if (!projectPath) throw new Error("项目工作区未就绪");
    const remoteIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: "25db8db2-d27b-40de-a23e-697b3c127234",
      workspacePath: projectPath,
    });
    // 项目选择会创建独立 cwd；离线远端必须使用选择后的路径才能覆盖同路径身份隔离。
    // 只构造离线 open-set，不连接 SSH；调用真实 store 的 add/activate，复现新 tab 置顶的顺序。
    const localId = await browser.execute(
      (path, identity) => {
        const store = (window as NavigationWindow).__zcodeTabStoreE2E;
        const localTab = store
          ?.getState()
          .tabs.find(
            (tab) =>
              tab.kind === "workspace" && tab.workspacePath === path && !tab.workspaceIdentity,
          );
        if (!store || !localTab) throw new Error("本地项目 tab 未就绪");
        store.getState().addTab(path, {
          workspaceIdentity: identity,
          remoteTarget: {
            kind: "ssh",
            host: "offline.example.com",
            username: "dev",
            port: 22,
          },
        });
        store.getState().activateTab(localTab.id);
        return localTab.id;
      },
      projectPath,
      remoteIdentity,
    );

    const before = await readNavigation();
    facts.before = before;
    expect(before.activeTabId).toBe(localId);
    expect(before.activeWorkspaceIdentity).toBeNull();
    expect(before.tabs[0]?.workspaceIdentity).toBe(remoteIdentity);
    expect(before.tabs[0]?.remoteSessionId).toBeNull();
    expect(before.tabs[1]?.id).toBe(localId);

    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    const workOutsideProject = $(`[data-testid="${TID_COMPOSER_WORK_OUTSIDE_PROJECT}"]`);
    await workOutsideProject.waitForDisplayed({ timeout: 10_000 });
    await workOutsideProject.click();
    await browser.waitUntil(
      async () => {
        const state = await readNavigation();
        return (
          state.activeWorkspacePath !== null &&
          state.activeWorkspacePath !== DEFAULT_WORKSPACE &&
          state.activeWorkspacePath !== projectPath &&
          state.activeWorkspaceIdentity === null &&
          state.tabs.find((tab) => tab.id === state.activeTabId)?.workspacePurpose ===
            "conversation"
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: `${CASE_MARKER}: 点击后没有进入本地 conversation workspace`,
      },
    );
    const after = await readNavigation();
    expect(await readDraftProjectId()).toBeNull();
    // 未归类任务现在准备独立目录；身份隔离不能再绑定退役的 workspace/default 常量。
    expect(dirname(after.activeWorkspacePath!)).toBe(
      join(getE2EAppDataPaths().storageRoot, "workspace"),
    );
    expect((await stat(after.activeWorkspacePath!)).isDirectory()).toBe(true);
    await waitForWorkspaceApp(after.activeWorkspacePath!, 10_000);
    facts.after = after;
    expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.workspacePurpose).toBe(
      "conversation",
    );
    expect(after.tabs.find((tab) => tab.id === localId)).toEqual(before.tabs[1]);
    expect(after.tabs.find((tab) => tab.workspaceIdentity === remoteIdentity)).toEqual(
      before.tabs[0],
    );

    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="composer-project-menu"] [data-project-name="${projectName}"]`).click();
    const trigger = $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`);
    await browser.waitUntil(async () => (await trigger.getText()).includes(projectName));
    expect(await readDraftProjectId()).toBeTruthy();
    await trigger.moveTo();
    await $(`[data-testid="${TID_COMPOSER_PROJECT_DETACH}"]`).click();
    await browser.waitUntil(async () => {
      const state = await readNavigation();
      return (
        state.tabs.find((tab) => tab.id === state.activeTabId)?.workspacePurpose ===
          "conversation" && !(await trigger.getText()).includes(projectName)
      );
    });
    expect(await readDraftProjectId()).toBeNull();
  });
});
