import { expect, it } from "vite-plus/test";
import {
  catalogWorkgroupEntries,
  catalogWorkgroupId,
  isCatalogLibraryEntryVisible,
} from "./MinesCatalogTree.logic";

const mine = { id: "mine", kind: "thread" as const, title: "Mine" };

it("keeps imported agent histories out of the default library even without a loaded shell", () => {
  const entity = {
    ...mine,
    importSource: { executionProjectId: "execution", kind: "subagent" as const },
  };
  expect(isCatalogLibraryEntryVisible({ entity, pinned: false })).toBe(false);
  expect(isCatalogLibraryEntryVisible({ entity, pinned: true })).toBe(true);
});

it("hides known native agents while keeping regular and forked mines visible", () => {
  for (const relationshipToParent of ["subagent", "fork", null] as const)
    expect(
      isCatalogLibraryEntryVisible({
        entity: mine,
        pinned: false,
        thread: { archivedAt: null, lineage: { relationshipToParent } },
      }),
    ).toBe(relationshipToParent !== "subagent");
});

it("retains the archive filter for explicitly pinned agents", () => {
  expect(
    isCatalogLibraryEntryVisible({
      entity: mine,
      pinned: true,
      thread: { archivedAt: "2026-10-26T00:00:00Z", lineage: { relationshipToParent: "subagent" } },
    }),
  ).toBe(false);
});

it("keeps pins visible while Workgroups replaces the personal library", () => {
  const group = { id: catalogWorkgroupId("friends"), kind: "group" as const, title: "Friends" };
  for (const mode of ["personal", "workgroups"] as const) {
    expect(isCatalogLibraryEntryVisible({ entity: mine, pinned: true, mode })).toBe(true);
    expect(isCatalogLibraryEntryVisible({ entity: group, pinned: true, mode })).toBe(true);
    expect(isCatalogLibraryEntryVisible({ entity: mine, pinned: false, mode })).toBe(
      mode === "personal",
    );
    expect(isCatalogLibraryEntryVisible({ entity: group, pinned: false, mode })).toBe(
      mode === "workgroups",
    );
  }
});

it("hides the current device in the personal library without hiding other devices or pins", () => {
  const local = {
    id: "local",
    kind: "device" as const,
    title: "Current",
    hostRef: { environmentId: "local", entityId: "local" },
  };
  const remote = {
    ...local,
    id: "remote",
    hostRef: { environmentId: "local", entityId: "cloud:remote" },
  };
  expect(
    isCatalogLibraryEntryVisible({ entity: local, pinned: false, primaryEnvironmentId: "local" }),
  ).toBe(false);
  expect(
    isCatalogLibraryEntryVisible({ entity: local, pinned: true, primaryEnvironmentId: "local" }),
  ).toBe(true);
  expect(
    isCatalogLibraryEntryVisible({ entity: remote, pinned: false, primaryEnvironmentId: "local" }),
  ).toBe(true);
});

it("finds workgroups even after arranging them inside personal sections", () => {
  const group = { id: catalogWorkgroupId("friends"), kind: "group" as const, title: "Friends" };
  expect(
    catalogWorkgroupEntries({ version: 1, roots: [], pins: [], entities: [mine, group] }),
  ).toEqual([{ entity: group, parentId: null, children: [], orphaned: false }]);
});
