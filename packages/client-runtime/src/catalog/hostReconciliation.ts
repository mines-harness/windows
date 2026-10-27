import {
  catalogHostId,
  type MinesCatalog,
  type MinesCatalogEntry,
  type MinesCatalogSnapshot,
} from "./index.ts";

interface HostProject {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
}
interface HostThread extends HostProject {
  readonly projectId: string;
  readonly archivedAt: string | null;
  readonly pinnedAt?: string | null;
  readonly lineage?: {
    readonly parentThreadId: string | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
}

function catalogEntries(snapshot: MinesCatalogSnapshot) {
  const entries = new Map<string, MinesCatalogEntry>();
  const append = (items: readonly MinesCatalogEntry[]) => {
    for (const entry of items) {
      entries.set(entry.entity.id, entry);
      append(entry.children);
    }
  };
  append(snapshot.roots);
  return entries;
}

export function hiddenCatalogExecutionProjects(snapshot: MinesCatalogSnapshot) {
  const entries = catalogEntries(snapshot);
  const explicit = new Set<string>();
  const inferred = new Set<string>();
  const actual = new Set<string>();
  for (const entity of snapshot.entities) {
    const source = entity.importSource;
    if (!source || !entity.hostRef) continue;
    const id = catalogHostId("project", entity.hostRef.environmentId, source.executionProjectId);
    if (entity.kind === "project" && entity.id === id && source.sourceProject === null)
      explicit.add(id);
    else if (entity.kind === "thread" && source.sourceProject === null) inferred.add(id);
    else if (source.sourceProject) actual.add(id);
  }
  return new Set(
    [...explicit, ...inferred].filter(
      (id) =>
        (explicit.has(id) || !actual.has(id)) &&
        entries.get(id)?.entity.kind === "project" &&
        entries.get(id)?.children.length === 0,
    ),
  );
}

export function reconcileCatalogHostItems(
  catalog: MinesCatalog,
  input: {
    readonly projects: readonly HostProject[];
    readonly threads: readonly HostThread[];
    readonly environmentIds: ReadonlySet<string>;
    readonly scratchProjectIds: ReadonlySet<string>;
  },
) {
  const snapshot = catalog.getSnapshot();
  const hidden = hiddenCatalogExecutionProjects(snapshot);
  const placements = catalogEntries(snapshot);
  const threads = input.threads.filter(
    (thread) => input.environmentIds.has(thread.environmentId) && thread.archivedAt === null,
  );
  const byId = new Map(
    threads.map((thread) => [catalogHostId("thread", thread.environmentId, thread.id), thread]),
  );
  catalog.transaction(() => {
    for (const project of input.projects) {
      const id = catalogHostId("project", project.environmentId, project.id);
      if (
        !input.environmentIds.has(project.environmentId) ||
        input.scratchProjectIds.has(id) ||
        hidden.has(id)
      )
        continue;
      const current = catalog.getEntity(id);
      catalog.upsert({
        ...current,
        id,
        kind: "project",
        title: current?.importSource ? current.title : project.title,
        hostRef: { environmentId: project.environmentId, entityId: project.id },
      });
    }
    for (const thread of threads) {
      const id = catalogHostId("thread", thread.environmentId, thread.id);
      const first = !catalog.has(id);
      const current = catalog.getEntity(id);
      const projectId = catalogHostId("project", thread.environmentId, thread.projectId);
      const entity = {
        ...current,
        id,
        kind: "thread" as const,
        title: current?.importSource ? current.title : thread.title,
        hostRef: { environmentId: thread.environmentId, entityId: thread.id },
      };
      const parentId =
        !input.scratchProjectIds.has(projectId) && !hidden.has(projectId) && catalog.has(projectId)
          ? projectId
          : null;
      catalog.upsert(entity, { parentId });
      if (!placements.has(id) && catalog.has(id))
        placements.set(id, {
          entity,
          parentId: catalog.getParentId(id),
          children: [],
          orphaned: false,
        });
      if (first && catalog.has(id) && thread.pinnedAt != null) catalog.pin(id);
    }
    for (const thread of threads) {
      if (thread.lineage?.relationshipToParent !== "subagent" || !thread.lineage.parentThreadId)
        continue;
      const id = catalogHostId("thread", thread.environmentId, thread.id);
      const parentId = catalogHostId("thread", thread.environmentId, thread.lineage.parentThreadId);
      if (!catalog.has(id) || !catalog.has(parentId)) continue;
      const automaticProject = catalogHostId("project", thread.environmentId, thread.projectId);
      const sourceProject = catalog.getEntity(id)?.importSource?.sourceProject;
      const automaticSourceProject = sourceProject
        ? `imported-project:${JSON.stringify([thread.environmentId, sourceProject.id])}`
        : undefined;
      const current = placements.get(id);
      if (
        current?.parentId !== null &&
        current?.parentId !== automaticProject &&
        current?.parentId !== automaticSourceProject
      )
        continue;
      const visited = new Set([id]);
      let ancestor: string | null = parentId;
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        const source = byId.get(ancestor);
        ancestor =
          source?.lineage?.relationshipToParent === "subagent" && source.lineage.parentThreadId
            ? catalogHostId("thread", source.environmentId, source.lineage.parentThreadId)
            : null;
      }
      if (ancestor) continue;
      let placementAncestor: string | null = parentId;
      while (placementAncestor && placementAncestor !== id)
        placementAncestor = placements.get(placementAncestor)?.parentId ?? null;
      if (placementAncestor === id) continue;
      catalog.move(id, parentId);
      if (current) placements.set(id, { ...current, parentId });
    }
  });
}
