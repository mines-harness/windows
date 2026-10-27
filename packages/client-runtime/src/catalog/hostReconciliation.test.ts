import { expect, it } from "vite-plus/test";
import { MinesCatalog, catalogHostId } from "./index.ts";
import { hiddenCatalogExecutionProjects, reconcileCatalogHostItems } from "./hostReconciliation.ts";

const projectId = catalogHostId("project", "env", "execution");
const threadId = (id: string) => catalogHostId("thread", "env", id);
const host = { id: "execution", environmentId: "env", title: "Execution" };
const thread = (id: string) => ({
  id,
  environmentId: "env",
  projectId: "execution",
  title: `Host ${id}`,
  archivedAt: null,
});
function reconcile(catalog: MinesCatalog, threads = [thread("root")]) {
  reconcileCatalogHostItems(catalog, {
    projects: [host],
    threads,
    environmentIds: new Set(["env"]),
    scratchProjectIds: new Set(),
  });
}

it("preserves imported metadata, source title and a manual section placement", () => {
  const catalog = new MinesCatalog();
  catalog.upsert({ id: "manual", kind: "section", title: "Manual" });
  const importSource = { executionProjectId: "execution", sourceProject: null, agentName: "Scout" };
  catalog.upsert(
    { id: threadId("root"), kind: "thread", title: "Original source title", importSource },
    { parentId: "manual" },
  );
  reconcile(catalog);
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === "manual")?.children[0],
  ).toMatchObject({ entity: { title: "Original source title", importSource } });
});

it("hides an explicit empty execution record but keeps its manually grouped children", () => {
  const catalog = new MinesCatalog();
  catalog.upsert({
    id: projectId,
    kind: "project",
    title: "Execution",
    hostRef: { environmentId: "env", entityId: "execution" },
    importSource: { executionProjectId: "execution", sourceProject: null },
  });
  reconcile(catalog, []);
  expect(hiddenCatalogExecutionProjects(catalog.getSnapshot()).has(projectId)).toBe(true);
  catalog.upsert({ id: "manual", kind: "thread", title: "Manual" }, { parentId: projectId });
  expect(hiddenCatalogExecutionProjects(catalog.getSnapshot()).has(projectId)).toBe(false);
});

it("nests subagent shells even when the child arrives first and preserves a section override", () => {
  const catalog = new MinesCatalog();
  const child = {
    ...thread("child"),
    lineage: { parentThreadId: "root", relationshipToParent: "subagent" as const },
  };
  reconcile(catalog, [child, thread("root")]);
  const project = catalog.getSnapshot().roots.find((entry) => entry.entity.id === projectId);
  expect(project?.children[0]?.children[0]?.entity.id).toBe(threadId("child"));
  catalog.upsert({ id: "manual", kind: "section", title: "Manual" });
  catalog.move(threadId("child"), "manual");
  reconcile(catalog, [child, thread("root")]);
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === "manual")?.children[0]?.entity
      .id,
  ).toBe(threadId("child"));
});

it("repairs a prior logical source-project placement but preserves an unrelated project override", () => {
  const catalog = new MinesCatalog();
  const sourceProject = { id: "/workspace/mines", title: "mines" };
  const logicalId = `imported-project:${JSON.stringify(["env", sourceProject.id])}`;
  catalog.upsert({
    id: logicalId,
    kind: "project",
    title: sourceProject.title,
    importSource: { executionProjectId: "execution", sourceProject },
  });
  for (const name of ["root", "child"])
    catalog.upsert(
      {
        id: threadId(name),
        kind: "thread",
        title: name,
        importSource: { executionProjectId: "execution", sourceProject },
      },
      { parentId: logicalId },
    );
  const child = {
    ...thread("child"),
    lineage: { parentThreadId: "root", relationshipToParent: "subagent" as const },
  };
  reconcile(catalog, [thread("root"), child]);
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === logicalId)?.children[0]
      ?.children[0]?.entity.id,
  ).toBe(threadId("child"));

  const manualId = `imported-project:${JSON.stringify(["env", "/workspace/other"])}`;
  catalog.upsert({ id: manualId, kind: "project", title: "Other project" });
  catalog.move(threadId("child"), manualId);
  reconcile(catalog, [thread("root"), child]);
  expect(
    catalog.getSnapshot().roots.find((entry) => entry.entity.id === manualId)?.children[0]?.entity
      .id,
  ).toBe(threadId("child"));
});

it("keeps unknown project grouping, scratch roots and catalog tombstones", () => {
  const catalog = new MinesCatalog();
  reconcile(catalog);
  expect(hiddenCatalogExecutionProjects(catalog.getSnapshot()).size).toBe(0);
  catalog.removeContainer(projectId);
  reconcile(catalog);
  expect(catalog.has(projectId)).toBe(false);
  const scratch = new MinesCatalog();
  reconcileCatalogHostItems(scratch, {
    projects: [host],
    threads: [thread("root")],
    environmentIds: new Set(["env"]),
    scratchProjectIds: new Set([projectId]),
  });
  expect(scratch.getSnapshot().roots.map((entry) => entry.entity.id)).toEqual([threadId("root")]);
});

it("preserves archived imported metadata and manual subagent placements during host refresh", () => {
  const catalog = new MinesCatalog();
  catalog.upsert({ id: "manual", kind: "section", title: "Manual" });
  const sourceProject = { id: "/workspace/mines", title: "Source mines" };
  const importSource = { executionProjectId: "execution", sourceProject, agentName: "Scout" };
  catalog.upsert(
    {
      id: projectId,
      kind: "project",
      title: "Source project",
      importSource,
      hostRef: { environmentId: "env", entityId: "execution" },
    },
    { parentId: "manual" },
  );
  catalog.upsert(
    {
      id: threadId("root"),
      kind: "thread",
      title: "Source root",
      importSource,
      hostRef: { environmentId: "env", entityId: "root" },
    },
    { parentId: projectId },
  );
  catalog.upsert(
    {
      id: threadId("child"),
      kind: "thread",
      title: "Manually placed agent",
      importSource,
      hostRef: { environmentId: "env", entityId: "child" },
    },
    { parentId: "manual" },
  );
  catalog.pin(threadId("root"));
  catalog.setContextInstructions(projectId, "Keep these project instructions");
  const before = catalog.getSnapshot();
  catalog.archiveSection("manual", { includeContents: true });
  const child = {
    ...thread("child"),
    lineage: { parentThreadId: "root", relationshipToParent: "subagent" as const },
  };
  reconcile(catalog, [thread("root"), child]);
  catalog.restoreSection("manual");
  expect(catalog.getSnapshot().roots).toEqual(before.roots);
  expect(catalog.getSnapshot().pins).toEqual(before.pins);
  expect(catalog.getSnapshot().contexts).toEqual(before.contexts);
});
