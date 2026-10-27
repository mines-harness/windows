import { MinesCatalog, catalogHostId } from "@t3tools/client-runtime/catalog";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { applyImportedCatalog, persistImportedCatalog } from "./importCatalog.logic";
import { BackgroundImportQueue, type BackgroundImportJob } from "./backgroundImports.logic";

const input = {
  environmentId: "mac",
  projectId: "project",
  title: "Altizy",
  sourceSection: { id: "native-section", title: "Work" },
};

it("repairs existing projectless imports into one source root with nested subagents", () => {
  const catalog = new MinesCatalog();
  const projectId = catalogHostId("project", "mac", "project");
  const root = ThreadId.make("import:codex:root");
  const child = ThreadId.make("import:codex:child");
  catalog.upsert({ id: projectId, kind: "project", title: "cwd" });
  for (const threadId of [root, child])
    catalog.upsert(
      { id: catalogHostId("thread", "mac", threadId), kind: "thread", title: threadId },
      { parentId: projectId },
    );
  applyImportedCatalog(catalog, { ...input, sourceProject: null }, [
    {
      threadId: child,
      title: "Child",
      sourceThreadId: "child",
      sourceParentThreadId: "root",
      parentThreadId: root,
      sourceProject: null,
      kind: "subagent",
      agentName: "Ada",
    },
    { threadId: root, title: "Root", sourceThreadId: "root", sourceProject: null, kind: "thread" },
  ]);
  const section = catalog.getSnapshot().roots.find((entry) => entry.entity.title === "Work");
  expect(section?.children.map((entry) => entry.entity.id)).toEqual([
    catalogHostId("thread", "mac", root),
  ]);
  expect(section?.children[0]?.children[0]?.entity.importSource?.agentName).toBe("Ada");
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === projectId)?.children,
  ).toEqual([]);
});

it.each(["inherited section", "source project"] as const)(
  "repairs already imported subagents placed directly under their %s",
  (placement) => {
    const catalog = new MinesCatalog();
    const section = `imported-section:${JSON.stringify([input.environmentId, input.sourceSection.id])}`;
    const sourceProject =
      placement === "source project" ? { id: "native-project", title: "Source project" } : null;
    const logicalProject = sourceProject
      ? `imported-project:${JSON.stringify([input.environmentId, sourceProject.id])}`
      : null;
    catalog.upsert({ id: section, kind: "section", title: input.sourceSection.title });
    if (logicalProject)
      catalog.upsert(
        { id: logicalProject, kind: "project", title: "Source project" },
        { parentId: section },
      );
    const root = ThreadId.make("import:codex:root");
    const child = ThreadId.make("import:codex:child");
    const rootId = catalogHostId("thread", input.environmentId, root);
    const childId = catalogHostId("thread", input.environmentId, child);
    for (const id of [rootId, childId])
      catalog.upsert({ id, kind: "thread", title: id }, { parentId: logicalProject ?? section });

    applyImportedCatalog(catalog, { ...input, sourceProject }, [
      { threadId: child, title: "Child", kind: "subagent", parentThreadId: root, sourceProject },
      { threadId: root, title: "Root", kind: "thread", sourceProject },
    ]);

    const importedSection = catalog
      .getSnapshot()
      .roots.find((entry) => entry.entity.id === section);
    const roots = logicalProject
      ? importedSection?.children[0]?.children
      : importedSection?.children;
    expect(roots?.map((entry) => entry.entity.id)).toEqual([rootId]);
    expect(roots?.[0]?.children.map((entry) => entry.entity.id)).toEqual([childId]);
  },
);

it("keeps explicit source projects under their real section and preserves a manually placed conversation", () => {
  const catalog = new MinesCatalog();
  const manual = catalog.createSection("My layout");
  const chosen = ThreadId.make("import:codex:chosen");
  catalog.upsert(
    { id: catalogHostId("thread", "mac", chosen), kind: "thread", title: "My title" },
    { parentId: manual },
  );
  applyImportedCatalog(catalog, input, [
    {
      threadId: ThreadId.make("import:codex:project-root"),
      title: "Project conversation",
      sourceProject: { id: "real-native-project", title: "Actual source project" },
    },
    { threadId: chosen, title: "Native title", sourceProject: null },
  ]);
  const roots = catalog.getSnapshot().roots;
  const source = roots.find((entry) => entry.entity.title === "Work")?.children[0];
  expect(source?.entity.title).toBe("Actual source project");
  expect(source?.children[0]?.entity.title).toBe("Project conversation");
  expect(roots.find((entry) => entry.entity.id === manual)?.children[0]?.entity.title).toBe(
    "My title",
  );
});

it("preserves hidden imported titles, metadata, manual placements and pins through reimport and restore", () => {
  const catalog = new MinesCatalog();
  const sourceProject = { id: "native-project", title: "Source project" };
  const root = ThreadId.make("import:codex:root");
  const child = ThreadId.make("import:codex:child");
  const imported = [
    { threadId: child, title: "Child", kind: "subagent" as const, parentThreadId: root },
    { threadId: root, title: "Root", kind: "thread" as const },
  ];
  applyImportedCatalog(catalog, { ...input, sourceProject }, imported);
  const manual = catalog.createSection("My organization");
  const executionId = catalogHostId("project", input.environmentId, input.projectId);
  const logicalId = `imported-project:${JSON.stringify([input.environmentId, sourceProject.id])}`;
  const rootId = catalogHostId("thread", input.environmentId, root);
  const childId = catalogHostId("thread", input.environmentId, child);
  catalog.upsert(
    { id: "manual-project", kind: "project", title: "Hand-picked mines" },
    {
      parentId: manual,
    },
  );
  catalog.move(executionId, manual);
  catalog.move(logicalId, manual);
  catalog.move(childId, "manual-project");
  for (const [id, title] of [
    [executionId, "My execution project"],
    [logicalId, "My source project"],
    [rootId, "My root mine"],
    [childId, "My agent mine"],
  ]) {
    const entity = catalog.getEntity(id!)!;
    catalog.upsert({
      ...entity,
      title: title!,
      importSource: { ...entity.importSource!, agentName: "Remembered source metadata" },
    });
    catalog.pin(id!);
  }
  catalog.setContextInstructions(logicalId, "Keep the source instructions");
  const before = catalog.getSnapshot();
  catalog.archiveSection(manual, { includeContents: true });

  const reloaded = new MinesCatalog();
  reloaded.applyUpdate(catalog.encodeUpdate());
  applyImportedCatalog(reloaded, { ...input, sourceProject }, imported);
  reloaded.restoreSection(manual);

  expect(reloaded.getSnapshot().roots).toEqual(before.roots);
  expect(reloaded.getSnapshot().pins).toEqual(before.pins);
  expect(reloaded.getSnapshot().contexts).toEqual(before.contexts);
});

it("binds legacy completed imports only on explicit refresh and persists their newly discovered project section", async () => {
  const catalog = new MinesCatalog();
  const project = catalogHostId("project", "mac", "project");
  catalog.upsert({ id: project, kind: "project", title: "My project title" });
  const flush = vi.fn(async () => {});
  const open = vi.fn(async () => ({ catalog, flush }));
  const owner = () => "current-account";
  const job = {
    id: "legacy",
    environmentId: EnvironmentId.make("mac"),
    environmentLabel: "Mac",
    projectId: ProjectId.make("project"),
    commandId: CommandId.make("create"),
    title: "Altizy",
    workspaceRoot: "/code/altizy",
    createWorkspaceRootIfMissing: false,
    projectReady: true,
    options: {},
    status: "complete",
    error: null,
    totals: {
      imported: 1,
      existing: 0,
      skipped: 0,
      native: 1,
      transcripts: 0,
      partial: 0,
      failed: 0,
      unavailable: 0,
    },
    sourceReports: [],
  };
  const importPage = vi.fn(async (refreshed: BackgroundImportJob) => {
    const result = { importedCount: 0, skippedCount: 0, sourceSection: input.sourceSection };
    await persistImportedCatalog(refreshed, result, { accountId: owner, open });
    return result;
  });
  const queue = new BackgroundImportQueue({
    load: () =>
      JSON.stringify({
        version: 1,
        jobs: [job, { ...job, id: "bound", catalogAccountId: "another-account" }],
      }),
    save: () => {},
    currentCatalogAccountId: owner,
    checkAccess: (item) => (item.catalogAccountId !== owner() ? "Account changed" : null),
    createProject: vi.fn(),
    importPage,
  });
  expect(queue.getSnapshot().jobs[0]?.catalogAccountId).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
  queue.refreshCompleted();
  await queue.whenIdle();
  expect(queue.getSnapshot().jobs.map((item) => item.catalogAccountId)).toEqual([
    "current-account",
    "another-account",
  ]);
  expect(importPage).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith("current-account");
  expect(flush).toHaveBeenCalledOnce();
  expect(catalog.getSnapshot().roots[0]?.entity.title).toBe("Work");
  expect(catalog.getSnapshot().roots[0]?.children[0]?.entity.title).toBe("My project title");
});

it("imports real sections for new and existing root projects without duplicating them", () => {
  const catalog = new MinesCatalog();
  const project = catalogHostId("project", "mac", "project");
  catalog.upsert({ id: project, kind: "project", title: "My project title" });
  applyImportedCatalog(catalog, input);
  applyImportedCatalog(catalog, input);
  expect(catalog.getSnapshot().roots).toHaveLength(1);
  expect(catalog.getSnapshot().roots[0]?.entity.title).toBe("Work");
  expect(catalog.getSnapshot().roots[0]?.children[0]?.entity.title).toBe("My project title");
});

it("refreshes only stale generated imported-mine catalog labels", () => {
  const catalog = new MinesCatalog();
  const project = catalogHostId("project", "mac", "project");
  catalog.upsert({ id: project, kind: "project", title: "My project" });
  const placeholder =
    '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
  for (const [threadId, title] of [
    ["import:codex:stale", placeholder],
    ["import:codex:renamed", "My chosen mine title"],
  ] as const) {
    catalog.upsert(
      { id: catalogHostId("thread", "mac", threadId), kind: "thread", title },
      { parentId: project },
    );
  }
  applyImportedCatalog(catalog, input, [
    {
      threadId: ThreadId.make("import:codex:stale"),
      title: "Actual native title",
      sourceSection: { id: "studio", title: "Studio" },
    },
    {
      threadId: ThreadId.make("import:codex:renamed"),
      title: "Different native title",
      sourceSection: { id: "studio", title: "Studio" },
    },
  ]);
  const entities = catalog.getSnapshot().entities;
  expect(
    entities.find((entity) => entity.id === catalogHostId("thread", "mac", "import:codex:stale"))
      ?.title,
  ).toBe("Actual native title");
  expect(
    entities.find((entity) => entity.id === catalogHostId("thread", "mac", "import:codex:renamed"))
      ?.title,
  ).toBe("My chosen mine title");
});

it("repairs an unsectioned imported title while preserving its existing placement", () => {
  const catalog = new MinesCatalog();
  const manual = catalog.createSection("My organization");
  const project = catalogHostId("project", "mac", "project");
  const threadId = ThreadId.make("import:codex:unsectioned");
  const id = catalogHostId("thread", "mac", threadId);
  catalog.upsert({ id: project, kind: "project", title: "My project" }, { parentId: manual });
  catalog.upsert(
    {
      id,
      kind: "thread",
      title: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
    },
    { parentId: project },
  );
  applyImportedCatalog(catalog, input, [{ threadId, title: "Actual native title" }]);
  const placed = catalog.getSnapshot().roots.find((entry) => entry.entity.id === manual)
    ?.children[0]?.children[0];
  expect(placed?.entity.title).toBe("Actual native title");
  expect(placed?.parentId).toBe(project);
});

it("places a newly created project and direct-section mine on the first import page", () => {
  const catalog = new MinesCatalog();
  applyImportedCatalog(catalog, input, [
    {
      threadId: ThreadId.make("new-thread"),
      title: "New mine",
      sourceSection: { id: "studio", title: "Studio" },
    },
  ]);
  const roots = catalog.getSnapshot().roots;
  expect(
    roots
      .find((entry) => entry.entity.title === "Work")
      ?.children.map((entry) => entry.entity.title),
  ).toEqual(["Altizy"]);
  expect(
    roots
      .find((entry) => entry.entity.title === "Studio")
      ?.children.map((entry) => entry.entity.title),
  ).toEqual(["New mine"]);
});

it("places imported direct-section mines and preserves titles and manually organized projects", () => {
  const catalog = new MinesCatalog();
  const manual = catalog.createSection("My organization");
  const project = catalogHostId("project", "mac", "project");
  catalog.upsert({ id: project, kind: "project", title: "My project" }, { parentId: manual });
  const thread = catalogHostId("thread", "mac", "thread");
  catalog.upsert({ id: thread, kind: "thread", title: "My mine title" }, { parentId: project });
  applyImportedCatalog(catalog, input, [
    {
      threadId: ThreadId.make("thread"),
      title: "Original title",
      sourceSection: { id: "studio", title: "Studio" },
    },
  ]);
  const snapshot = catalog.getSnapshot();
  expect(snapshot.roots.find((entry) => entry.entity.id === manual)?.children[0]?.entity.id).toBe(
    project,
  );
  expect(
    snapshot.roots.find((entry) => entry.entity.title === "Studio")?.children[0]?.entity.title,
  ).toBe("My mine title");
});
