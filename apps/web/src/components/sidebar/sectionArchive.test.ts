import { expect, it, vi } from "vite-plus/test";
import { MinesCatalog } from "@t3tools/client-runtime/catalog";
import {
  archiveCatalogSection,
  relatedSectionThreads,
  restoreCatalogSection,
} from "./sectionArchive";

function setup() {
  const catalog = new MinesCatalog();
  const section = catalog.createSection("Work");
  catalog.upsert(
    {
      id: "project",
      kind: "project",
      title: "App",
      hostRef: { environmentId: "host", entityId: "app" },
    },
    { parentId: section },
  );
  catalog.upsert(
    {
      id: "mine",
      kind: "thread",
      title: "Mine",
      hostRef: { environmentId: "host", entityId: "one" },
    },
    { parentId: "project" },
  );
  catalog.pin("mine");
  return { catalog, section };
}

it("includes all active native project mines and explicit section mines, without restoring old archives", () => {
  const { catalog, section } = setup();
  expect(
    relatedSectionThreads(catalog.getSectionContents(section), [
      { environmentId: "host", id: "one", projectId: "elsewhere", archivedAt: null },
      { environmentId: "host", id: "two", projectId: "app", archivedAt: null },
      { environmentId: "host", id: "old", projectId: "app", archivedAt: "2026-10-01" },
      { environmentId: "other", id: "three", projectId: "app", archivedAt: null },
    ]),
  ).toEqual([
    { environmentId: "host", threadId: "one" },
    { environmentId: "host", threadId: "two" },
  ]);
});

it("archives host mines and retains their restore journal across a reload", async () => {
  const { catalog, section } = setup();
  const archive = vi.fn().mockResolvedValue(undefined);
  const unarchive = vi.fn().mockResolvedValue(undefined);
  const refs = [{ environmentId: "host", threadId: "one" }];
  await archiveCatalogSection({
    flush: vi.fn().mockResolvedValue(undefined),
    catalog,
    sectionId: section,
    threads: refs,
    archive,
    unarchive,
  });
  expect(archive).toHaveBeenCalledWith(refs[0]);
  expect(catalog.getSnapshot().pins).toEqual([]);
  const restored = new MinesCatalog();
  restored.applyUpdate(catalog.encodeUpdate());
  await restoreCatalogSection({
    flush: vi.fn().mockResolvedValue(undefined),
    catalog: restored,
    sectionId: section,
    unarchive,
  });
  expect(unarchive).toHaveBeenCalledWith(refs[0]);
  expect(restored.getSnapshot().pins[0]?.entity.id).toBe("mine");
});

it("rolls back completed host archives when a later device fails", async () => {
  const { catalog, section } = setup();
  const one = { environmentId: "host", threadId: "one" };
  const two = { environmentId: "offline", threadId: "two" };
  const unarchive = vi.fn().mockResolvedValue(undefined);
  await expect(
    archiveCatalogSection({
      flush: vi.fn().mockResolvedValue(undefined),
      catalog,
      sectionId: section,
      threads: [one, two],
      archive: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Offline")),
      unarchive,
    }),
  ).rejects.toThrow("Offline");
  expect(unarchive).toHaveBeenCalledWith(one);
  expect(catalog.getArchivedSections()).toEqual([]);
  expect(catalog.getSnapshot().pins[0]?.entity.id).toBe("mine");
});

it("retains a recoverable journal if rollback or restore is interrupted", async () => {
  const { catalog, section } = setup();
  const one = { environmentId: "host", threadId: "one" };
  const two = { environmentId: "offline", threadId: "two" };
  await expect(
    archiveCatalogSection({
      flush: vi.fn().mockResolvedValue(undefined),
      catalog,
      sectionId: section,
      threads: [one, two],
      archive: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Offline")),
      unarchive: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Disconnected")),
    }),
  ).rejects.toThrow("Archived sections");
  expect(catalog.getArchivedSectionThreads(section)).toEqual([one]);
  await expect(
    restoreCatalogSection({
      flush: vi.fn().mockResolvedValue(undefined),
      catalog,
      sectionId: section,
      unarchive: vi.fn().mockRejectedValue(new Error("Still offline")),
    }),
  ).rejects.toThrow("Still offline");
  expect(catalog.getArchivedSections()).toHaveLength(1);
  await restoreCatalogSection({
    flush: vi.fn().mockResolvedValue(undefined),
    catalog,
    sectionId: section,
    unarchive: vi.fn().mockResolvedValue(undefined),
  });
  expect(catalog.getArchivedSections()).toEqual([]);
});

it("persists recovery before the first host call, including an unacknowledged interrupted target", async () => {
  const { catalog, section } = setup();
  const refs = [{ environmentId: "host", threadId: "one" }];
  let saved: Uint8Array | undefined;
  await expect(
    archiveCatalogSection({
      flush: vi.fn().mockResolvedValue(undefined),
      catalog,
      sectionId: section,
      threads: refs,
      archive: async () => {
        saved = catalog.encodeUpdate();
        throw new Error("Disconnected before acknowledgment");
      },
      unarchive: vi.fn().mockRejectedValue(new Error("Offline")),
    }),
  ).rejects.toThrow("Archived sections");
  const reopened = new MinesCatalog();
  reopened.applyUpdate(saved!);
  expect(reopened.getArchivedSectionThreads(section)).toEqual(refs);
  const unarchive = vi.fn().mockResolvedValue(undefined);
  await restoreCatalogSection({
    flush: vi.fn().mockResolvedValue(undefined),
    catalog: reopened,
    sectionId: section,
    unarchive,
  });
  expect(unarchive).toHaveBeenCalledWith(refs[0]);
  expect(reopened.getSnapshot().pins[0]?.entity.id).toBe("mine");
});

it("does not mutate hosts when the recovery journal cannot be persisted", async () => {
  const { catalog, section } = setup();
  const archive = vi.fn();
  await expect(
    archiveCatalogSection({
      catalog,
      sectionId: section,
      threads: [{ environmentId: "host", threadId: "one" }],
      archive,
      unarchive: vi.fn(),
      flush: vi.fn().mockRejectedValue(new Error("Storage full")),
    }),
  ).rejects.toThrow("Storage full");
  expect(archive).not.toHaveBeenCalled();
});

it("does not archive unrelated imported logical projects that share an execution host project", () => {
  const { catalog, section } = setup();
  const project = catalog.getEntity("project")!;
  catalog.upsert({
    ...project,
    importSource: {
      executionProjectId: "app",
      sourceProject: { id: "logical-one", title: "First source" },
    },
  });
  expect(
    relatedSectionThreads(catalog.getSectionContents(section), [
      { environmentId: "host", id: "one", projectId: "app", archivedAt: null },
      { environmentId: "host", id: "unrelated", projectId: "app", archivedAt: null },
    ]),
  ).toEqual([{ environmentId: "host", threadId: "one" }]);
});

it("preserves a new archive journal received during an asynchronous restore", async () => {
  const { catalog, section } = setup();
  const old = { environmentId: "host", threadId: "one" };
  const concurrent = { environmentId: "peer", threadId: "two" };
  catalog.archiveSection(section, { includeContents: true, archivedThreads: [old] });
  const unarchive = vi.fn(async () => {
    catalog.archiveSection(section, { includeContents: true, archivedThreads: [concurrent] });
  });
  await restoreCatalogSection({
    catalog,
    sectionId: section,
    unarchive,
    flush: vi.fn().mockResolvedValue(undefined),
  });
  expect(catalog.getArchivedSectionThreads(section)).toEqual([concurrent]);
  expect(catalog.getArchivedSections()).toHaveLength(1);
});
