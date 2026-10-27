import type {
  MinesCatalogEntity,
  MinesCatalogSnapshot,
  MinesCatalogEntry,
} from "@t3tools/client-runtime/catalog";

const WORKGROUP_PREFIX = "workgroup:";
export const catalogWorkgroupId = (groupKey: string) => `${WORKGROUP_PREFIX}${groupKey}`;
export const catalogWorkgroupKey = (id: string) =>
  id.startsWith(WORKGROUP_PREFIX) ? id.slice(WORKGROUP_PREFIX.length) : null;

export function isCatalogLibraryEntryVisible(input: {
  readonly entity: MinesCatalogEntity;
  readonly thread?:
    | {
        readonly archivedAt: string | null;
        readonly lineage: { readonly relationshipToParent: "subagent" | "fork" | null };
      }
    | undefined;
  readonly pinned: boolean;
  readonly mode?: "personal" | "workgroups";
  readonly primaryEnvironmentId?: string | null;
}) {
  if (input.thread && input.thread.archivedAt !== null) return false;
  if (!input.pinned) {
    const workgroup = catalogWorkgroupKey(input.entity.id) !== null;
    if (workgroup !== (input.mode === "workgroups")) return false;
    if (
      input.entity.kind === "device" &&
      input.primaryEnvironmentId != null &&
      input.entity.hostRef?.entityId === input.primaryEnvironmentId
    )
      return false;
  }
  if (input.entity.kind !== "thread") return true;
  return (
    input.pinned ||
    (input.entity.importSource?.kind !== "subagent" &&
      input.thread?.lineage.relationshipToParent !== "subagent")
  );
}

export function catalogWorkgroupEntries(
  snapshot: MinesCatalogSnapshot,
): readonly MinesCatalogEntry[] {
  return snapshot.entities
    .filter((entity) => catalogWorkgroupKey(entity.id) !== null)
    .map((entity) => ({ entity, parentId: null, children: [], orphaned: false }));
}
