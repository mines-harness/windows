import type { MinesCatalog, MinesCatalogEntity } from "@t3tools/client-runtime/catalog";

interface ThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}
type ThreadAction = (thread: ThreadRef) => Promise<void>;
const refKey = (environmentId: string, id: string) => JSON.stringify([environmentId, id]);

export function relatedSectionThreads(
  entities: readonly MinesCatalogEntity[],
  threads: readonly {
    readonly environmentId: string;
    readonly id: string;
    readonly projectId: string;
    readonly archivedAt: string | null;
  }[],
): readonly ThreadRef[] {
  const projects = new Set(
    entities.flatMap((entity) =>
      entity.kind === "project" && !entity.importSource && entity.hostRef
        ? [refKey(entity.hostRef.environmentId, entity.hostRef.entityId)]
        : [],
    ),
  );
  const mines = new Set(
    entities.flatMap((entity) =>
      entity.kind === "thread" && entity.hostRef
        ? [refKey(entity.hostRef.environmentId, entity.hostRef.entityId)]
        : [],
    ),
  );
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        (mines.has(refKey(thread.environmentId, thread.id)) ||
          projects.has(refKey(thread.environmentId, thread.projectId))),
    )
    .map((thread) => ({ environmentId: thread.environmentId, threadId: thread.id }));
}

export async function archiveCatalogSection({
  catalog,
  sectionId,
  threads,
  archive,
  unarchive,
  flush,
}: {
  readonly catalog: MinesCatalog;
  readonly sectionId: string;
  readonly threads: readonly ThreadRef[];
  readonly archive: ThreadAction;
  readonly unarchive: ThreadAction;
  readonly flush: () => Promise<void>;
}) {
  // Persist the complete recovery journal before the first host mutation. Closing the
  // window between host acknowledgements still leaves a reversible section archive.
  const operationId = catalog.archiveSection(sectionId, {
    includeContents: true,
    archivedThreads: threads,
  });
  const attempted: ThreadRef[] = [];
  try {
    await flush();
    for (const thread of threads) {
      attempted.push(thread);
      await archive(thread);
    }
  } catch (cause) {
    const retained: ThreadRef[] = [];
    for (const thread of attempted.toReversed()) {
      try {
        await unarchive(thread);
      } catch {
        retained.push(thread);
      }
    }
    catalog.transaction(() => {
      catalog.restoreSection(sectionId, [operationId]);
      if (retained.length > 0)
        catalog.archiveSection(sectionId, {
          includeContents: true,
          archivedThreads: retained.toReversed(),
        });
    });
    if (retained.length > 0) {
      await flush();
      throw new Error(
        "Some mines were archived before the connection was interrupted. Restore the section from Archived sections to recover them.",
        { cause },
      );
    }
    await flush();
    throw cause;
  }
}

export async function restoreCatalogSection({
  catalog,
  sectionId,
  unarchive,
  flush,
}: {
  readonly catalog: MinesCatalog;
  readonly sectionId: string;
  readonly unarchive: ThreadAction;
  readonly flush: () => Promise<void>;
}) {
  // Keep the replicated journal until every host acknowledges restoration. A retry is safe
  // after a disconnect because the existing unarchive command is idempotent.
  const token = catalog.getSectionArchiveToken(sectionId);
  const threads = catalog.getArchivedSectionThreads(sectionId);
  for (const thread of threads) await unarchive(thread);
  catalog.restoreSection(sectionId, token);
  await flush();
}
