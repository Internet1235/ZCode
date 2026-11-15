// ORG01–04：生产组织模块隔离验收；不启动 App、Agent 或现有 Server。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "zcode-organization-"));
const environment = new Map(
  ["HOME", "USERPROFILE", "ZCODE_DATA_BASE_DIR"].map((name) => [name, process.env[name]]),
);
for (const name of environment.keys()) process.env[name] = root;

try {
  // paths.ts 在加载时捕获目录；生产模块必须在隔离环境建立后再加载。
  const { ChannelClient, ChannelServer, Emitter, ProxyChannel } =
    await import("../../../../rpc/src/index.ts");
  const { RemoteServiceAccess, connectViaProtocol } =
    await import("../../../../client/src/index.ts");
  const {
    buildRemoteWorkspaceIdentity,
    buildServerRemoteWorkspaceIdentity,
    generateTraceId,
    remoteHostIdFromWorkspaceIdentity,
    ServiceChannels,
    ZCODE_AGENT_PROVIDER,
  } = await import("@zcode/shared");
  const { TaskIndexRepo } = await import("../../../../services/src/session/taskIndexRepo.ts");
  const {
    bindRemoteProjectIdentities,
    createProjectService,
    createRemoteIdentityRegistrationCache,
  } = await import("../../../../services/src/project/index.ts");
  const { createTaskGroupService, groupTaskKey } =
    await import("../../../../services/src/task-groups/index.ts");
  const { SourceServerWorkspaceIdentityMapper, SourceServerWorkspaceIdentityChannelServer } =
    await import("../../../../services/src/source-server-workspace/sourceServerWorkspaceIdentityChannelServer.ts");
  const { createSourceServerWorkspaceService } =
    await import("../../../../services/src/source-server-workspace/sourceServerWorkspaceService.ts");
  const { createWindowHostControllerRuntime } =
    await import("../../../../desktop/src/host/windowHostControllerService.ts");
  const { mutateProjectTask, readProjectTaskMeta } =
    await import("../../../../ui/src/project-sidebar/task-mutation.ts");

  function deferred() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function rpc(register, action, options = {}) {
    const serverInput = new Emitter();
    const clientInput = new Emitter();
    const protocol = { onMessage: clientInput.event, send: (value) => serverInput.fire(value) };
    const server = new ChannelServer(
      {
        onMessage: serverInput.event,
        send: (value) => clientInput.fire(value),
      },
      "organization-fixture",
      40,
      true,
    );
    const abort = new AbortController();
    const client = options.protocol ? undefined : new ChannelClient(protocol);
    let deadline;
    try {
      register(server);
      const services = options.protocol
        ? connectViaProtocol(protocol, { ...options, signal: abort.signal })
        : new RemoteServiceAccess(client, options);
      server.ready();
      await Promise.race([
        action(services),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("fixture.rpc-timeout")), 3000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      abort.abort();
      client?.dispose();
      server.dispose();
      serverInput.dispose();
      clientInput.dispose();
    }
  }

  let fixtureNumber = 0;
  async function sourceFixture(kind, action) {
    const directory = join(root, `source-${++fixtureNumber}`);
    const workspacePath = join(directory, "workspace");
    const deletedPath = join(directory, "deleted-only");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(deletedPath, { recursive: true });
    const stable = (path) =>
      buildServerRemoteWorkspaceIdentity({
        serverId: "organization-source",
        workspacePath: path,
      });
    const canonical = (path) =>
      kind === "ssh"
        ? buildRemoteWorkspaceIdentity(path, {
            kind: "ssh",
            host: "organization-fixture.invalid",
            username: "fixture",
            port: 22,
          })
        : kind === "local"
          ? path
          : stable(path);
    const hostId = remoteHostIdFromWorkspaceIdentity(stable(workspacePath));
    assert.ok(hostId);
    const index = new TaskIndexRepo(undefined, hostId, join(directory, "tasks.sqlite"));
    const mapper = new SourceServerWorkspaceIdentityMapper();
    const registrations = [];
    const aliases = {
      async resolveCanonicalWorkspaceKey(input) {
        registrations.push(input);
        return { canonicalKey: canonical(input.workspacePath), mergedKeys: [] };
      },
      async getFailedPathCount() {
        return 0;
      },
      async getAbandonedPathCount() {
        return 0;
      },
      async listMigrationReports() {
        return { rows: [] };
      },
      async abandonFailedWorkspace() {},
      async retryFailedWorkspace() {},
    };
    const workspaceService = createSourceServerWorkspaceService(aliases, {
      defaultWorkspaceIdentity: stable,
      onResolved: ({ workspacePath: path, canonicalWorkspaceKey }) =>
        mapper.register({
          stableIdentity: stable(path),
          canonicalIdentity: canonicalWorkspaceKey,
          workspacePath: path,
        }),
    });
    const registerIdentity = createRemoteIdentityRegistrationCache();
    const rawProject = createProjectService({
      ownerHostId: hostId,
      repository: () => index.getProjectRepository(),
      workspaceDirectory: join(directory, "drafts"),
    });
    const project = bindRemoteProjectIdentities(rawProject, (path) =>
      registerIdentity(
        workspaceService,
        path,
        async () =>
          (await workspaceService.resolveWorkspace({ workspacePath: path })).canonicalWorkspaceKey,
      ),
    );
    const facts = async (refs) => {
      const tree = await project.readTree({ hostId, includeDeletedTasks: true });
      const all = [
        ...tree.tasks,
        ...(tree.deletedTasks ?? []).map((task) => ({ ...task, deleted: true })),
      ];
      return refs.flatMap((ref) =>
        all
          .filter(
            (task) =>
              groupTaskKey(task) === groupTaskKey(ref) &&
              task.hostId === ref.hostId &&
              task.workspacePath === ref.workspacePath,
          )
          .map((task) => ({ ...task, ...ref })),
      );
    };
    let changes = 0;
    const groups = createTaskGroupService({
      database: () => index.getOrganizationDatabase(),
      resolveTasks: facts,
      isRegisteredSourceWorkspace: (task) => mapper.isRegisteredSourceWorkspace(task),
      async afterChange() {
        changes++;
      },
    });
    const task = (taskId = "task-1", path = workspacePath, identity = stable(path)) => ({
      taskId,
      workspacePath: path,
      workspaceIdentity: identity,
    });
    const groupTask = (taskId = "task-1", path = workspacePath) => ({
      ...task(taskId, path),
      hostId,
    });
    const seed = async (taskId, path, deleted = false) =>
      index.applyCliFacts({
        meta: {
          taskId,
          traceId: generateTraceId(taskId),
          title: `Fixture ${taskId}`,
          workspacePath: path,
          ...(kind === "local" ? {} : { workspaceIdentity: canonical(path) }),
          createdAt: 100,
          updatedAt: 200,
          mode: "default",
          provider: ZCODE_AGENT_PROVIDER,
        },
        deleted,
      });
    const writes = [];
    const taskService = {
      async archiveTask(target) {
        writes.push({ kind: "archive", target });
        await index.updateTaskState({ ...target, patch: { archived: true } });
      },
      async unarchiveTask(target) {
        writes.push({ kind: "unarchive", target });
        await index.updateTaskState({ ...target, patch: { archived: false } });
      },
      async getTaskMeta(target) {
        const tree = await project.readTree({ hostId });
        return tree.tasks.find((entry) => groupTaskKey(entry) === groupTaskKey(target)) ?? null;
      },
    };
    const register = (server) => {
      const mapped = new SourceServerWorkspaceIdentityChannelServer(server, mapper);
      mapped.registerChannel(ServiceChannels.Project, ProxyChannel.fromService(project));
      mapped.registerChannel(ServiceChannels.TaskGroups, ProxyChannel.fromService(groups));
      mapped.registerChannel(ServiceChannels.ZCodeTask, ProxyChannel.fromService(taskService));
      mapped.registerChannel(
        ServiceChannels.SourceServerWorkspace,
        ProxyChannel.fromService(workspaceService),
      );
    };
    try {
      await seed("task-1", workspacePath);
      await seed("task-2", workspacePath);
      await seed("deleted-1", deletedPath, true);
      const saved = await rawProject.saveProject({
        name: "Fixture project",
        roots: [workspacePath],
      });
      await action({
        index,
        mapper,
        project,
        rawProject,
        groups,
        workspaceService,
        registrations,
        stable,
        canonical,
        hostId,
        workspacePath,
        deletedPath,
        saved,
        task,
        groupTask,
        taskService,
        writes,
        register,
        changes: () => changes,
      });
    } finally {
      index.close({ throwOnError: true });
    }
  }

  function controllerFixture(options = {}) {
    const workspacePath = join(root, "controller-workspace");
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: "controller-source",
      workspacePath,
    });
    const scope = {
      kind: "remote",
      sourceServerId: "controller-source",
      remoteSessionId: "attachment-1",
      workspacePath,
      workspaceIdentity: identity,
    };
    const meta = {
      taskId: "controller-task",
      traceId: generateTraceId("controller-task"),
      workspacePath,
      workspaceIdentity: identity,
      title: "Controller fixture",
      createdAt: 10,
      updatedAt: 20,
      mode: "default",
      unreadAt: 50,
    };
    const state = { writes: [], reports: [], archived: false, readFails: false };
    const taskService = {
      async listTasks() {
        if (state.readFails) throw new Error("fixture.read-failed");
        if (options.beforeRead) await options.beforeRead();
        return state.archived ? [] : [{ ...meta }];
      },
      async listPinnedTasks() {
        if (state.readFails) throw new Error("fixture.read-failed");
        return [];
      },
      async listArchivedTasks() {
        if (state.readFails) throw new Error("fixture.read-failed");
        return state.archived ? [{ ...meta }] : [];
      },
      async archiveTask(target) {
        if (options.failMutation) throw new Error("fixture.mutation-failed");
        state.writes.push(target);
        state.archived = true;
        state.readFails = options.failAfterCommit === true;
      },
      async setTaskUnread(target) {
        state.writes.push(target);
        if (target.unread || target.expectedUnreadAt === meta.unreadAt)
          meta.unreadAt = target.unread ? 51 : undefined;
        return { ...meta };
      },
    };
    const source = { scope, taskService, sourceAvailability: "online" };
    let current = source;
    let id = 0;
    const runtime = createWindowHostControllerRuntime({
      createId: () => `controller-id-${++id}`,
      async readHostTaskList() {
        return [];
      },
      resolveSource: () => current,
      onSourceError: (owner, operation, error) => state.reports.push({ owner, operation, error }),
    });
    const address = { ...scope, taskId: meta.taskId };
    delete address.kind;
    return {
      runtime,
      state,
      scope,
      address,
      meta,
      source,
      setSource: (value) => {
        current = value;
      },
    };
  }

  const cases = [
    [
      "source-without-controller-uses-only-task-service",
      () =>
        sourceFixture("ssh", async (f) => {
          await f.project.readTree({ hostId: f.hostId });
          await rpc(f.register, async (services) => {
            assert.equal(services.windowControllerService, undefined);
            await mutateProjectTask(
              { service: services.zcodeTaskService, controller: services.windowControllerService },
              f.task(),
              { kind: "archive", archived: true },
            );
            assert.equal(
              (await services.projectService.readTree({ hostId: f.hostId })).tasks[0].archived,
              true,
            );
            await mutateProjectTask({ service: services.zcodeTaskService }, f.task(), {
              kind: "archive",
              archived: false,
            });
            assert.equal(f.writes.length, 2);
            assert.equal(f.writes[0].target.workspaceIdentity, f.canonical(f.workspacePath));
            assert.equal(
              (await readProjectTaskMeta({ service: services.zcodeTaskService }, f.task()))
                .workspaceIdentity,
              f.stable(f.workspacePath),
            );
          });
        }),
    ],
    ...[false, true].map((protocol) => [
      `explicit-controller-capability-${protocol ? "protocol" : "client"}`,
      async () => {
        const writes = [];
        await rpc(
          (server) =>
            server.registerChannel(
              ServiceChannels.WindowController,
              ProxyChannel.fromService({
                async mutateTask(value) {
                  writes.push(value);
                  return null;
                },
              }),
            ),
          async (services) => {
            assert.ok(services.windowControllerService);
            const task = {
              taskId: "remote-task",
              workspacePath: join(root, "capability-workspace"),
              workspaceIdentity: buildServerRemoteWorkspaceIdentity({
                serverId: "explicit-controller",
                workspacePath: join(root, "capability-workspace"),
              }),
            };
            await mutateProjectTask(
              { service: services.zcodeTaskService, controller: services.windowControllerService },
              task,
              { kind: "archive", archived: true },
              "attachment-1",
            );
            assert.equal(writes.length, 1);
            assert.equal(writes[0].address.sourceServerId, "explicit-controller");
            assert.equal(writes[0].address.remoteSessionId, "attachment-1");
            assert.equal(writes[0].address.workspaceIdentity, task.workspaceIdentity);
          },
          { windowControllerService: true, protocol },
        );
      },
    ]),
    ...["stable", "ssh", "local"].map((kind) => [
      `source-${kind}-canonical-organization`,
      () =>
        sourceFixture(kind, async (f) => {
          const prepared = await f.project.prepareSession({
            projectId: f.saved.id,
            hostId: f.hostId,
          });
          assert.equal(prepared.workspacePath, f.workspacePath);
          assert.equal(prepared.workspaceIdentity, f.canonical(f.workspacePath));
          const tree = await f.project.readTree({ hostId: f.hostId, includeDeletedTasks: true });
          assert.equal(tree.tasks[0].hostId, f.hostId);
          assert.equal(tree.tasks[0].workspaceIdentity, f.canonical(f.workspacePath));
          assert.equal(tree.deletedTasks[0].workspaceIdentity, f.canonical(f.deletedPath));
          assert.equal(
            f.registrations.filter((entry) => entry.workspacePath === f.workspacePath).length,
            1,
          );
          assert.equal(
            f.registrations.filter((entry) => entry.workspacePath === f.deletedPath).length,
            1,
          );
          await rpc(f.register, async (services) => {
            const group = await services.taskGroupService.save({ title: "User group" });
            const admission = {
              tasks: [f.groupTask(), f.groupTask("task-2")],
              placement: {
                task: f.groupTask(),
                groupId: group.id,
                creationId: "first-send-1",
              },
            };
            await services.taskGroupService.admit(admission);
            const structure = await services.taskGroupService.read();
            assert.equal(structure.members[0].workspaceKey, f.stable(f.workspacePath));
            assert.ok(
              structure.order.some(
                (node) => node.type === "task" && node.key === groupTaskKey(f.groupTask("task-2")),
              ),
            );
            await services.taskGroupService.move({
              node: { type: "task", task: f.groupTask() },
              sourceGroupId: group.id,
              groupId: null,
            });
            const afterMove = await services.taskGroupService.read();
            await services.taskGroupService.admit(admission);
            assert.deepEqual(
              await services.taskGroupService.read(),
              afterMove,
              "repeated admit must not undo user organization",
            );
            await assert.rejects(
              services.taskGroupService.move({
                node: { type: "task", task: f.groupTask() },
                sourceGroupId: group.id,
                groupId: null,
              }),
              /task-group.stale-source/,
            );
            await mutateProjectTask({ service: services.zcodeTaskService }, f.task(), {
              kind: "archive",
              archived: true,
            });
            await assert.rejects(
              services.taskGroupService.move({
                node: { type: "task", task: f.groupTask() },
                sourceGroupId: null,
                groupId: group.id,
              }),
              /task-group.task-unavailable/,
            );
            await services.taskGroupService.admit({
              tasks: [f.groupTask("deleted-1", f.deletedPath)],
            });
            const db = await f.index.getOrganizationDatabase();
            const stored = db
              .prepare(
                "SELECT workspace_key,root_path,host_id,cli_created_at,cli_updated_at,project_id FROM tasks WHERE task_id='task-1'",
              )
              .get();
            assert.equal(stored.workspace_key, f.canonical(f.workspacePath));
            assert.equal(stored.root_path, f.workspacePath);
            assert.equal(stored.host_id, f.hostId);
            assert.equal(stored.cli_created_at, 100);
            assert.equal(stored.cli_updated_at, 200);
            assert.equal(stored.project_id, null);
            assert.equal(
              db
                .prepare("SELECT creation_id FROM task_group_admissions WHERE task_id='task-1'")
                .get().creation_id,
              "first-send-1",
            );
          });
        }),
    ]),
    [
      "source-pair-does-not-authorize-another-host-or-path",
      () =>
        sourceFixture("ssh", async (f) => {
          await f.project.readTree({ hostId: f.hostId });
          const ref = { ...f.groupTask(), workspaceIdentity: f.canonical(f.workspacePath) };
          const otherHost = remoteHostIdFromWorkspaceIdentity(
            buildServerRemoteWorkspaceIdentity({
              serverId: "other-source",
              workspacePath: f.workspacePath,
            }),
          );
          for (const invalid of [
            { ...ref, hostId: otherHost },
            { ...ref, workspacePath: f.deletedPath },
            { ...ref, workspaceIdentity: f.canonical(join(root, "unregistered")) },
          ])
            await assert.rejects(
              f.groups.admit({ tasks: [invalid] }),
              /task-group.host-identity-mismatch/,
            );
          await assert.rejects(
            f.groups.admit({
              tasks: [ref],
              placement: {
                task: { ...ref, taskId: "absent-task" },
                groupId: null,
                creationId: "absent-creation",
              },
            }),
            /task-group.created-task-unavailable/,
          );
          const strict = createTaskGroupService({
            database: () => f.index.getOrganizationDatabase(),
            resolveTasks: async (refs) => refs,
            async afterChange() {},
          });
          await assert.rejects(strict.admit({ tasks: [ref] }), /task-group.host-identity-mismatch/);
        }),
    ],
    [
      "identity-mapping-keeps-user-json-binary-and-diagnostics",
      () =>
        sourceFixture("ssh", async (f) => {
          await f.project.readTree({ hostId: f.hostId });
          const bytes = new Uint8Array([1, 2, 3]);
          const date = new Date(1000);
          const userText = JSON.stringify([f.canonical(f.workspacePath), "task-1"]);
          const mapped = f.mapper.mapOutgoing({
            bytes,
            date,
            text: userText,
            nested: { type: "task", key: userText },
          });
          assert.equal(mapped.bytes, bytes);
          assert.equal(mapped.date, date);
          assert.equal(mapped.text, userText);
          assert.equal(mapped.nested.key, userText);
          await rpc(f.register, async (services) => {
            const result = await services.sourceServerWorkspaceService.resolveWorkspace({
              workspacePath: f.workspacePath,
            });
            assert.equal(result.canonicalWorkspaceKey, f.canonical(f.workspacePath));
          });
        }),
    ],
    [
      "controller-refresh-after-commit-is-not-a-mutation-failure",
      async () => {
        const f = controllerFixture({ failAfterCommit: true });
        try {
          await f.runtime.service.mutateTask({
            address: f.address,
            mutation: { kind: "archive", archived: true },
          });
          assert.equal(f.state.archived, true);
          assert.equal(f.state.writes.length, 1);
          assert.equal(f.state.reports.length, 1);
          assert.equal(f.state.reports[0].operation, "refresh");
          assert.match(String(f.state.reports[0].error), /fixture.read-failed/);
        } finally {
          f.runtime.dispose();
        }
      },
    ],
    ...["read", "mutation"].map((failure) => [
      `controller-${failure}-failure-still-rejects`,
      async () => {
        const f = controllerFixture({ failMutation: failure === "mutation" });
        if (failure === "read") f.state.readFails = true;
        try {
          await assert.rejects(
            f.runtime.service.mutateTask({
              address: f.address,
              mutation: { kind: "archive", archived: true },
            }),
            failure === "read" ? /fixture.read-failed/ : /fixture.mutation-failed/,
          );
          assert.equal(f.state.archived, false);
          assert.equal(f.state.writes.length, 0);
          assert.equal(f.state.reports.length, 0);
        } finally {
          f.runtime.dispose();
        }
      },
    ]),
    [
      "controller-normal-archive-and-unread-cas-controls",
      async () => {
        const f = controllerFixture();
        try {
          const stale = await f.runtime.service.mutateTask({
            address: f.address,
            mutation: { kind: "mark-read", expectedUnreadAt: 49 },
          });
          assert.equal(stale.unreadAt, 50);
          const cleared = await f.runtime.service.mutateTask({
            address: f.address,
            mutation: { kind: "mark-read", expectedUnreadAt: 50 },
          });
          assert.equal(cleared.unreadAt, undefined);
          await f.runtime.service.mutateTask({
            address: f.address,
            mutation: { kind: "archive", archived: true },
          });
          assert.equal(f.runtime.readTaskRows()[0].membership.archived, true);
          assert.equal(f.state.reports.length, 0);
        } finally {
          f.runtime.dispose();
        }
      },
    ],
    [
      "controller-source-change-before-unread-write-rejects",
      async () => {
        const held = deferred();
        const started = deferred();
        const f = controllerFixture({
          beforeRead: () => {
            started.resolve();
            return held.promise;
          },
        });
        try {
          const rejected = assert.rejects(
            f.runtime.service.mutateTask({
              address: f.address,
              mutation: { kind: "mark-read", expectedUnreadAt: 50 },
            }),
            /source.*失效/,
          );
          await started.promise;
          f.setSource({ ...f.source, taskService: { ...f.source.taskService } });
          held.resolve();
          await rejected;
          assert.equal(f.state.writes.length, 0);
        } finally {
          held.resolve();
          f.runtime.dispose();
        }
      },
    ],
  ];

  const results = [];
  for (const [name, run] of cases) {
    try {
      await run();
      results.push({ name, status: "passed" });
    } catch (error) {
      results.push({ name, status: "failed", error: error.stack ?? String(error) });
    }
  }
  console.log(JSON.stringify({ layer: "isolated-production-organization", results }, null, 2));
  if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
} finally {
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
}
