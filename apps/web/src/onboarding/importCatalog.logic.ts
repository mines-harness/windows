import { catalogHostId, type MinesCatalog } from "@t3tools/client-runtime/catalog";
import {
  isAgentSessionGeneratedContextTitle,
  type AgentSessionImportResult,
  type AgentSessionSourceSection,
  type AgentSessionSourceProject,
} from "@t3tools/contracts";

export function applyImportedCatalog(
  catalog: MinesCatalog,
  input: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly title: string;
    readonly sourceSection?: AgentSessionSourceSection | undefined;
    readonly sourceProject?: AgentSessionSourceProject | null | undefined;
  },
  threads: NonNullable<AgentSessionImportResult["catalogThreads"]> = [],
) {
  const projectId = catalogHostId("project", input.environmentId, input.projectId);
  const executionOnly =
    input.sourceProject !== undefined ||
    (threads.length > 0 && threads.every((thread) => thread.sourceProject !== undefined));
  const sectionId = (section: AgentSessionSourceSection) => {
    const id = `imported-section:${JSON.stringify([input.environmentId, section.id])}`;
    if (!catalog.has(id)) catalog.upsert({ id, kind: "section", title: section.title });
    return catalog.has(id) ? id : null;
  };
  const sourceProjectFor = (thread: (typeof threads)[number]) =>
    thread.sourceProject === undefined ? input.sourceProject : thread.sourceProject;
  const sourceProjectId = (source: AgentSessionSourceProject) =>
    `imported-project:${JSON.stringify([input.environmentId, source.id])}`;
  const initialParents = new Map<string, string | null>();
  const rememberParent = (id: string) => {
    if (catalog.has(id)) initialParents.set(id, catalog.getParentId(id));
  };
  rememberParent(projectId);
  for (const thread of threads) {
    rememberParent(catalogHostId("thread", input.environmentId, thread.threadId));
    const sourceProject = sourceProjectFor(thread);
    if (sourceProject) rememberParent(sourceProjectId(sourceProject));
  }
  catalog.transaction(() => {
    const previous = catalog.getEntity(projectId);
    catalog.upsert({
      ...previous,
      id: projectId,
      kind: "project",
      title: previous?.title ?? input.title,
      hostRef: { environmentId: input.environmentId, entityId: input.projectId },
      ...(executionOnly
        ? {
            importSource: {
              ...previous?.importSource,
              executionProjectId: input.projectId,
              sourceProject: null,
            },
          }
        : {}),
    });
    if (!executionOnly && input.sourceSection && catalog.has(projectId)) {
      const destination = sectionId(input.sourceSection);
      if (destination !== null && initialParents.get(projectId) == null)
        catalog.move(projectId, destination);
    }
    for (const thread of threads) {
      const id = catalogHostId("thread", input.environmentId, thread.threadId);
      const current = catalog.getEntity(id);
      const {
        threadId: _id,
        title: _title,
        sourceSection: _section,
        parentThreadId: _parent,
        rootThreadId: _root,
        ...provenance
      } = thread;
      const sourceProject = sourceProjectFor(thread);
      const repairTitle =
        current &&
        thread.threadId.startsWith("import:") &&
        isAgentSessionGeneratedContextTitle(current.title) &&
        !isAgentSessionGeneratedContextTitle(thread.title);
      const title = current && !repairTitle ? current.title : thread.title;
      catalog.upsert({
        ...current,
        id,
        kind: "thread",
        title,
        hostRef: { environmentId: input.environmentId, entityId: thread.threadId },
        importSource: {
          ...current?.importSource,
          ...provenance,
          executionProjectId: input.projectId,
          ...(sourceProject === undefined ? {} : { sourceProject }),
        },
      });
      if (sourceProject) {
        const logicalId = sourceProjectId(sourceProject);
        const existing = catalog.getEntity(logicalId);
        catalog.upsert({
          ...existing,
          id: logicalId,
          kind: "project",
          title: existing?.title ?? sourceProject.title,
          hostRef: { environmentId: input.environmentId, entityId: input.projectId },
          importSource: {
            ...existing?.importSource,
            executionProjectId: input.projectId,
            sourceProject,
          },
        });
      }
    }
  });
  // Register all parents before placement because import pages may list children first.
  catalog.transaction(() => {
    for (const thread of threads) {
      const id = catalogHostId("thread", input.environmentId, thread.threadId);
      if (!catalog.has(id)) continue;
      const initialParent = initialParents.get(id);
      const sourceProject = sourceProjectFor(thread);
      const sourceSection =
        thread.sourceSection ?? (sourceProject !== undefined ? input.sourceSection : undefined);
      const section = sourceSection ? sectionId(sourceSection) : null;
      let destination: string | null = sourceProject === null ? section : projectId;
      if (sourceProject) {
        const logical = sourceProjectId(sourceProject);
        if (catalog.has(logical)) {
          if (section !== null && initialParents.get(logical) == null)
            catalog.move(logical, section);
          destination = logical;
        }
      } else if (sourceProject === undefined && thread.sourceSection) destination = section;
      const parent = thread.parentThreadId
        ? catalogHostId("thread", input.environmentId, thread.parentThreadId)
        : null;
      if (thread.kind === "subagent" && parent && catalog.has(parent) && parent !== id)
        destination = parent;
      const oldSection = sourceSection
        ? `imported-section:${JSON.stringify([input.environmentId, sourceSection.id])}`
        : null;
      const automatic =
        initialParent == null ||
        initialParent === projectId ||
        (sourceProject != null && initialParent === sourceProjectId(sourceProject)) ||
        (oldSection !== null && initialParent === oldSection);
      if (automatic && (destination === null || catalog.has(destination)))
        catalog.move(id, destination);
    }
  });
}

export async function persistImportedCatalog(
  input: Parameters<typeof applyImportedCatalog>[1] & {
    readonly catalogAccountId?: string | undefined;
  },
  result: Pick<AgentSessionImportResult, "catalogThreads" | "sourceSection">,
  dependencies: {
    readonly accountId: () => string;
    readonly open: (
      accountId: string,
    ) => Promise<{ readonly catalog: MinesCatalog; readonly flush: () => Promise<void> }>;
  },
) {
  const accountId = input.catalogAccountId;
  if (accountId === undefined || accountId !== dependencies.accountId()) return;
  const handle = await dependencies.open(accountId);
  if (accountId !== dependencies.accountId()) return;
  applyImportedCatalog(
    handle.catalog,
    { ...input, sourceSection: result.sourceSection ?? input.sourceSection },
    result.catalogThreads,
  );
  await handle.flush();
}
