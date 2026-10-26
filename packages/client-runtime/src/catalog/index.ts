import * as Y from "yjs";
export { reconcileCatalogHostItems, hiddenCatalogExecutionProjects } from "./hostReconciliation.ts";
export {
  registerCatalogExecutionSource,
  registerCatalogExecutionHost,
  catalogBytesToBase64,
  catalogBytesFromBase64,
} from "./execution.ts";
export {
  minesAccountIdAtom,
  minesAccountEnvironmentIdsAtom,
  minesCatalogIdentityAtom,
} from "./identity.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  MinesCatalogEntity,
  MinesCatalogContextSource,
  type MinesCatalogContext,
  type MinesCatalogEntry,
  type MinesCatalogKind,
  type MinesCatalogSnapshot,
} from "@t3tools/contracts/minesCatalog";
import { MAX_CATALOG_CONTEXT_SOURCES, normalizeCatalogSourcePath } from "./context.ts";
export {
  catalogContextFor,
  MAX_CATALOG_CONTEXT_SOURCES,
  normalizeCatalogSourcePath,
  resolveCatalogContext,
  type ResolvedCatalogContext,
  type ResolvedCatalogContextLayer,
  type ResolvedCatalogContextSource,
} from "./context.ts";

export type { MinesCatalogEntity, MinesCatalogEntry, MinesCatalogKind, MinesCatalogSnapshot };
export type { MinesCatalogContext, MinesCatalogContextSource };

interface StoredContextSource extends MinesCatalogContextSource {
  readonly entityId: string;
}

interface Placement {
  readonly parentId: string | null;
  readonly placementId: string;
}

interface ArchivedThread {
  readonly environmentId: string;
  readonly threadId: string;
}

interface SectionArchive {
  readonly sectionId: string;
  readonly includeContents: boolean;
  readonly archivedThreads?: readonly ArchivedThread[];
  readonly entityIds: readonly string[];
}

function validArchivedThread(value: unknown): value is ArchivedThread {
  return (
    typeof value === "object" &&
    value !== null &&
    "environmentId" in value &&
    typeof value.environmentId === "string" &&
    "threadId" in value &&
    typeof value.threadId === "string"
  );
}

function validSectionArchive(value: unknown): value is SectionArchive {
  return (
    typeof value === "object" &&
    value !== null &&
    "sectionId" in value &&
    typeof value.sectionId === "string" &&
    "includeContents" in value &&
    typeof value.includeContents === "boolean" &&
    "entityIds" in value &&
    Array.isArray(value.entityIds) &&
    value.entityIds.every((id) => typeof id === "string") &&
    (!("archivedThreads" in value) ||
      (Array.isArray(value.archivedThreads) && value.archivedThreads.every(validArchivedThread)))
  );
}

interface OrderedReference {
  readonly entityId: string;
  readonly placementId: string;
}

export interface HostCatalogLifecycle {
  readonly id: string;
  readonly sequence: number;
  readonly state: "archived" | "active" | "deleted";
}

function validLifecycle(value: unknown): value is HostCatalogLifecycle {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "sequence" in value &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    "state" in value &&
    ["archived", "active", "deleted"].includes(String(value.state))
  );
}

export function mergeCatalogUpdates(updates: readonly Uint8Array[]): Uint8Array {
  for (const update of updates) Y.decodeUpdate(update);
  return Y.mergeUpdates([...updates]);
}

export function catalogStateVectorIncludes(current: Uint8Array, expected: Uint8Array): boolean {
  const available = Y.decodeStateVector(current);
  for (const [client, clock] of Y.decodeStateVector(expected))
    if ((available.get(client) ?? 0) < clock) return false;
  return true;
}

const CATALOG_LOCAL_ORIGIN = "mines-catalog-local";
const CATALOG_PEER_ORIGIN = "mines-catalog-peer";
const ROOT_ORDER = "order:root";
const decodeEntity = Schema.decodeUnknownOption(MinesCatalogEntity);
const decodeSource = Schema.decodeUnknownOption(MinesCatalogContextSource);

function placementId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function catalogHostId(kind: MinesCatalogKind, environmentId: string, entityId: string) {
  return `${kind}:${encodeURIComponent(environmentId)}:${encodeURIComponent(entityId)}`;
}

export function canCatalogContain(parent: MinesCatalogKind | null, child: MinesCatalogKind) {
  if (parent === null) return true;
  if (parent === "section") return child !== "section" && child !== "device";
  return (
    (parent === "project" && (child === "thread" || child === "group")) ||
    (parent === "thread" && child === "thread")
  );
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validReference(value: unknown): value is OrderedReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "entityId" in value &&
    typeof value.entityId === "string" &&
    "placementId" in value &&
    typeof value.placementId === "string"
  );
}

function validPlacement(value: unknown): value is Placement {
  return (
    typeof value === "object" &&
    value !== null &&
    "parentId" in value &&
    (value.parentId === null || typeof value.parentId === "string") &&
    "placementId" in value &&
    typeof value.placementId === "string"
  );
}

export class MinesCatalog {
  readonly document: Y.Doc;
  readonly #entities: Y.Map<MinesCatalogEntity>;
  readonly #placements: Y.Map<Placement>;
  readonly #pins: Y.Map<string | null>;
  readonly #deleted: Y.Map<true>;
  readonly #sectionArchives: Y.Map<SectionArchive>;
  readonly #restoredSectionArchives: Y.Map<true>;
  readonly #lifecycle: Y.Map<HostCatalogLifecycle>;
  readonly #contextInstructions: Y.Map<string>;
  readonly #contextSources: Y.Map<StoredContextSource>;
  readonly #contextSourcesDeleted: Y.Map<true>;
  readonly #listeners = new Set<() => void>();
  readonly #id: () => string;
  #snapshot: MinesCatalogSnapshot;
  #version = 0;

  constructor(options: { document?: Y.Doc; createId?: () => string } = {}) {
    this.document = options.document ?? new Y.Doc();
    this.#id = options.createId ?? placementId;
    this.#entities = this.document.getMap("entities");
    this.#placements = this.document.getMap("placements");
    this.#pins = this.document.getMap("pin-winners");
    this.#deleted = this.document.getMap("deleted");
    this.#sectionArchives = this.document.getMap("section-archives");
    this.#restoredSectionArchives = this.document.getMap("section-archives-restored");
    this.#lifecycle = this.document.getMap("host-lifecycle");
    this.#contextInstructions = this.document.getMap("context-instructions");
    this.#contextSources = this.document.getMap("context-sources");
    this.#contextSourcesDeleted = this.document.getMap("context-sources-deleted");
    this.#snapshot = this.#project();
    this.document.on("afterTransaction", this.#changed);
  }

  #changed = (transaction: Y.Transaction) => {
    if (transaction.changed.size === 0) return;
    this.#version += 1;
    this.#snapshot = this.#project();
    for (const listener of this.#listeners) listener();
  };

  getSnapshot = () => this.#snapshot;

  has(id: string) {
    return this.#entities.has(id) && !this.#deleted.has(id);
  }

  getEntity(id: string) {
    const entity = decodeEntity(this.#entities.get(id));
    return Option.isSome(entity) && entity.value.id === id && !this.#deleted.has(id)
      ? entity.value
      : undefined;
  }

  getParentId(id: string) {
    const placement = this.#placements.get(id);
    return validPlacement(placement) ? placement.parentId : null;
  }

  transaction(action: () => void) {
    this.document.transact(action, CATALOG_LOCAL_ORIGIN);
  }

  applyHostLifecycle(event: HostCatalogLifecycle) {
    if (!validLifecycle(event)) throw new Error("Invalid sidebar lifecycle event.");
    const key = `${event.id}:${event.sequence}`;
    if (this.#lifecycle.has(key)) return;
    this.document.transact(() => {
      // Immutable host events preserve sequence order across stale offline replicas.
      this.#lifecycle.set(key, { ...event });
      if (event.state === "deleted") this.#deleted.set(event.id, true);
    }, CATALOG_LOCAL_ORIGIN);
  }

  reconcileHostDevices(input: {
    environmentId: string;
    entityPrefix: string;
    devices: readonly { id: string; title: string }[];
    sequence: number;
  }) {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) return;
    const active = new Set(input.devices.map((device) => device.id));
    this.transaction(() => {
      for (const entity of this.#entities.values()) {
        if (
          entity.kind !== "device" ||
          entity.hostRef?.environmentId !== input.environmentId ||
          !entity.hostRef.entityId.startsWith(input.entityPrefix)
        )
          continue;
        this.applyHostLifecycle({
          id: entity.id,
          sequence: input.sequence,
          state: active.has(entity.hostRef.entityId) ? "active" : "archived",
        });
      }
      for (const device of input.devices) {
        if (!device.id.startsWith(input.entityPrefix)) continue;
        const id = catalogHostId("device", input.environmentId, device.id);
        this.upsert({
          id,
          kind: "device",
          title: device.title,
          hostRef: { environmentId: input.environmentId, entityId: device.id },
        });
        this.applyHostLifecycle({ id, sequence: input.sequence, state: "active" });
      }
    });
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  subscribeUpdates(listener: (update: Uint8Array, origin: unknown) => void) {
    this.document.on("update", listener);
    return () => {
      this.document.off("update", listener);
    };
  }

  encodeStateVector() {
    return Y.encodeStateVector(this.document);
  }
  encodeUpdate(remoteVector?: Uint8Array) {
    return Y.encodeStateAsUpdate(this.document, remoteVector);
  }
  applyUpdate(update: Uint8Array, origin: unknown = CATALOG_PEER_ORIGIN) {
    Y.applyUpdate(this.document, update, origin);
  }

  #order(parentId: string | null) {
    return this.document.getArray<OrderedReference>(
      parentId === null ? ROOT_ORDER : `order:entity:${parentId}`,
    );
  }

  #requireEntity(id: string) {
    const entity = this.#entities.get(id);
    if (!entity || this.#deleted.has(id)) throw new Error("This sidebar item no longer exists.");
    return entity;
  }

  #validateParent(entity: MinesCatalogEntity, parentId: string | null) {
    const parent = parentId === null ? null : this.#requireEntity(parentId);
    if (parentId === entity.id || !canCatalogContain(parent?.kind ?? null, entity.kind)) {
      throw new Error("This item cannot be placed in that container.");
    }
    const seen = new Set<string>();
    let ancestor = parentId;
    while (ancestor !== null) {
      if (ancestor === entity.id || seen.has(ancestor))
        throw new Error("This placement would create a sidebar cycle.");
      seen.add(ancestor);
      ancestor = this.#placements.get(ancestor)?.parentId ?? null;
    }
  }

  upsert(
    entity: MinesCatalogEntity,
    initial: { parentId?: string | null; beforeId?: string } = {},
  ) {
    const decoded = decodeEntity(entity);
    if (Option.isNone(decoded) || !entity.id || !entity.title.trim())
      throw new Error("Invalid sidebar item.");
    if (this.#deleted.has(entity.id)) return;
    const existing = this.#entities.get(entity.id);
    if (existing && existing.kind !== entity.kind)
      throw new Error("A sidebar item's kind cannot change.");
    if (existing && JSON.stringify(existing) === JSON.stringify(entity)) return;
    const requestedParentId = initial.parentId ?? null;
    const parentId =
      requestedParentId && this.#deleted.has(requestedParentId) ? null : requestedParentId;
    if (!this.#placements.has(entity.id)) this.#validateParent(entity, parentId);
    this.document.transact(() => {
      this.#entities.set(entity.id, { ...entity });
      if (!this.#placements.has(entity.id)) this.#move(entity.id, parentId, initial.beforeId);
    }, CATALOG_LOCAL_ORIGIN);
  }

  createSection(title: string) {
    const id = `section:${this.#id()}`;
    this.upsert({ id, kind: "section", title: title.trim() });
    return id;
  }

  rename(id: string, title: string) {
    const entity = this.#requireEntity(id);
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Enter a name for this item.");
    this.upsert({ ...entity, title: trimmed });
  }

  #requireContextOwner(id: string) {
    const entity = this.#requireEntity(id);
    if (entity.kind !== "section" && entity.kind !== "project")
      throw new Error("Instructions and sources belong to a project or section.");
    return entity;
  }

  setContextInstructions(entityId: string, instructions: string) {
    this.#requireContextOwner(entityId);
    if (instructions.length > 32_768)
      throw new Error("Keep custom instructions within 32,768 characters.");
    if ((this.#contextInstructions.get(entityId) ?? "") === instructions) return;
    this.document.transact(
      () => this.#contextInstructions.set(entityId, instructions),
      CATALOG_LOCAL_ORIGIN,
    );
  }

  addContextSource(entityId: string, input: Omit<MinesCatalogContextSource, "id">) {
    this.#requireContextOwner(entityId);
    if (input.kind !== "directory") throw new Error("Choose a folder as a context source.");
    const source = {
      ...input,
      id: `source:${this.#id()}`,
      path: normalizeCatalogSourcePath(input.path),
    };
    if (Option.isNone(decodeSource(source))) throw new Error("Invalid context source.");
    const existingPaths = new Set<string>();
    for (const existing of this.#contextSources.values()) {
      if (
        !existing ||
        existing.entityId !== entityId ||
        this.#contextSourcesDeleted.has(existing.id)
      )
        continue;
      existingPaths.add(JSON.stringify([existing.environmentId, existing.kind, existing.path]));
      if (
        existing.environmentId === source.environmentId &&
        existing.kind === source.kind &&
        existing.path === source.path
      )
        return existing.id;
    }
    if (existingPaths.size >= MAX_CATALOG_CONTEXT_SOURCES)
      throw new Error(
        `Keep context sources within ${MAX_CATALOG_CONTEXT_SOURCES} sources per project or section.`,
      );
    this.document.transact(
      () => this.#contextSources.set(source.id, { ...source, entityId }),
      CATALOG_LOCAL_ORIGIN,
    );
    return source.id;
  }

  removeContextSource(entityId: string, sourceId: string) {
    this.#requireContextOwner(entityId);
    const source = this.#contextSources.get(sourceId);
    if (!source || source.entityId !== entityId) return;
    this.document.transact(() => {
      for (const existing of this.#contextSources.values())
        if (
          existing?.entityId === entityId &&
          existing.environmentId === source.environmentId &&
          existing.kind === source.kind &&
          existing.path === source.path
        )
          this.#contextSourcesDeleted.set(existing.id, true);
    }, CATALOG_LOCAL_ORIGIN);
  }

  #move(id: string, parentId: string | null, beforeId?: string) {
    const order = this.#order(parentId);
    const placementId = this.#id();
    const beforePlacement = beforeId ? this.#placements.get(beforeId) : undefined;
    const index =
      beforePlacement?.parentId === parentId
        ? order.toArray().findIndex((ref) => ref.placementId === beforePlacement.placementId)
        : -1;
    order.insert(index < 0 ? order.length : index, [{ entityId: id, placementId }]);
    this.#placements.set(id, { parentId, placementId });
  }

  move(id: string, parentId: string | null, beforeId?: string) {
    this.#validateParent(this.#requireEntity(id), parentId);
    if (beforeId === id) return;
    this.document.transact(() => {
      if (parentId === null)
        for (const entry of this.#snapshot.roots)
          if (
            entry.orphaned &&
            this.getSectionArchiveToken(this.#placements.get(entry.entity.id)?.parentId ?? "")
              .length === 0
          )
            this.#move(entry.entity.id, null);
      this.#move(id, parentId, beforeId);
    }, CATALOG_LOCAL_ORIGIN);
  }

  pin(id: string, beforeId?: string) {
    this.#requireEntity(id);
    if (id === beforeId) return;
    this.document.transact(() => {
      const order = this.document.getArray<OrderedReference>("pin-order");
      const placementId = this.#id();
      const beforePlacement = beforeId ? this.#pins.get(beforeId) : undefined;
      const index = beforePlacement
        ? order.toArray().findIndex((ref) => ref.placementId === beforePlacement)
        : -1;
      order.insert(index < 0 ? order.length : index, [{ entityId: id, placementId }]);
      this.#pins.set(id, placementId);
    }, CATALOG_LOCAL_ORIGIN);
  }

  unpin(id: string) {
    this.document.transact(() => this.#pins.set(id, null), CATALOG_LOCAL_ORIGIN);
  }

  #descendantIds(id: string) {
    const children = new Map<string, string[]>();
    for (const [childId, placement] of this.#placements) {
      if (!validPlacement(placement) || placement.parentId === null) continue;
      const siblings = children.get(placement.parentId) ?? [];
      siblings.push(childId);
      children.set(placement.parentId, siblings);
    }
    const ids = new Set([id]);
    for (const parentId of ids)
      for (const childId of children.get(parentId) ?? []) ids.add(childId);
    return ids;
  }

  #sectionArchiveEntries(sectionId?: string) {
    return [...this.#sectionArchives.entries()].filter(
      (entry) =>
        !this.#restoredSectionArchives.has(entry[0]) &&
        validSectionArchive(entry[1]) &&
        (sectionId === undefined || entry[1].sectionId === sectionId),
    );
  }

  getSectionArchiveToken(id: string): readonly string[] {
    return this.#sectionArchiveEntries(id)
      .map(([key]) => key)
      .sort(compareIds);
  }

  getSectionContents(id: string) {
    if (this.#requireEntity(id).kind !== "section") throw new Error("Choose a section to archive.");
    const ids = this.#descendantIds(id);
    for (const [, archive] of this.#sectionArchiveEntries(id))
      for (const entityId of archive.entityIds) ids.add(entityId);
    ids.delete(id);
    return [...ids]
      .map((entityId) => this.getEntity(entityId))
      .filter((entity): entity is MinesCatalogEntity => entity !== undefined);
  }

  archiveSection(
    id: string,
    options: { includeContents: boolean; archivedThreads?: readonly ArchivedThread[] },
  ) {
    if (this.#requireEntity(id).kind !== "section") throw new Error("Choose a section to archive.");
    const entityIds = options.includeContents ? this.#descendantIds(id) : new Set([id]);
    const operationId = `section-archive:${this.#id()}`;
    this.document.transact(
      () =>
        this.#sectionArchives.set(operationId, {
          sectionId: id,
          includeContents: options.includeContents,
          entityIds: [...entityIds],
          archivedThreads: options.archivedThreads?.map((thread) => ({ ...thread })) ?? [],
        }),
      CATALOG_LOCAL_ORIGIN,
    );
    return operationId;
  }

  getArchivedSectionThreads(id: string): readonly ArchivedThread[] {
    const threads = new Map<string, ArchivedThread>();
    for (const [, archive] of this.#sectionArchiveEntries(id))
      for (const thread of archive.archivedThreads ?? [])
        threads.set(JSON.stringify([thread.environmentId, thread.threadId]), thread);
    return [...threads.entries()].sort(([a], [b]) => compareIds(a, b)).map(([, thread]) => thread);
  }

  restoreSection(id: string, observed: readonly string[] = this.getSectionArchiveToken(id)) {
    this.document.transact(() => {
      for (const operationId of observed) {
        const archive = this.#sectionArchives.get(operationId);
        if (validSectionArchive(archive) && archive.sectionId === id)
          this.#restoredSectionArchives.set(operationId, true);
      }
    }, CATALOG_LOCAL_ORIGIN);
  }

  getArchivedSections() {
    const sectionIds = new Set(
      this.#sectionArchiveEntries().map(([, archive]) => archive.sectionId),
    );
    return [...sectionIds]
      .map((id) => this.getEntity(id))
      .filter((entity): entity is MinesCatalogEntity => entity?.kind === "section")
      .sort((a, b) => compareIds(a.id, b.id));
  }

  #archivedEntityIds() {
    const archived = new Set<string>();
    const withContents = new Set<string>();
    for (const [, archive] of this.#sectionArchiveEntries()) {
      archived.add(archive.sectionId);
      if (archive.includeContents)
        for (const entityId of archive.entityIds) withContents.add(entityId);
    }
    if (withContents.size === 0) return archived;
    const children = new Map<string, string[]>();
    for (const [id, placement] of this.#placements) {
      if (!validPlacement(placement) || placement.parentId === null) continue;
      const siblings = children.get(placement.parentId) ?? [];
      siblings.push(id);
      children.set(placement.parentId, siblings);
    }
    // Include children discovered by an offline peer after the archive was created.
    for (const id of withContents) {
      archived.add(id);
      for (const childId of children.get(id) ?? []) withContents.add(childId);
    }
    return archived;
  }

  removeContainer(id: string) {
    const entity = this.#requireEntity(id);
    if (entity.kind !== "section" && entity.kind !== "project") {
      throw new Error("Delete conversations on the device that owns them.");
    }
    this.document.transact(() => this.#deleted.set(id, true), CATALOG_LOCAL_ORIGIN);
  }

  #project(): MinesCatalogSnapshot {
    const lifecycle = new Map<string, HostCatalogLifecycle>();
    for (const value of this.#lifecycle.values())
      if (validLifecycle(value) && (lifecycle.get(value.id)?.sequence ?? -1) < value.sequence)
        lifecycle.set(value.id, value);
    const archived = this.#archivedEntityIds();
    const entities = new Map<string, MinesCatalogEntity>();
    for (const [id, value] of this.#entities) {
      const entity = decodeEntity(value);
      if (
        Option.isSome(entity) &&
        entity.value.id === id &&
        !this.#deleted.has(id) &&
        !archived.has(id) &&
        lifecycle.get(id)?.state !== "archived" &&
        lifecycle.get(id)?.state !== "deleted"
      )
        entities.set(id, entity.value);
    }
    const entries = new Map<string, MinesCatalogEntry>();
    const children = new Map<string | null, MinesCatalogEntry[]>();
    const orphans: Array<{ entry: MinesCatalogEntry; formerParent: string; sourceIndex: number }> =
      [];
    const projected = new Set<string>();
    const projectOrder = (parentId: string | null) => {
      const order = this.#order(parentId).toArray();
      for (const [sourceIndex, ref] of order.entries()) {
        if (!validReference(ref) || projected.has(ref.entityId)) continue;
        const entity = entities.get(ref.entityId);
        const placement = this.#placements.get(ref.entityId);
        if (
          !entity ||
          !validPlacement(placement) ||
          placement.parentId !== parentId ||
          placement.placementId !== ref.placementId
        )
          continue;
        projected.add(entity.id);
        const parent = parentId === null ? null : entities.get(parentId);
        const orphaned =
          parentId !== null &&
          (!parent || !canCatalogContain(parent.kind, entity.kind) || parentId === entity.id);
        const entry: MinesCatalogEntry = {
          entity,
          children: [],
          parentId: orphaned ? null : parentId,
          orphaned,
        };
        entries.set(entity.id, entry);
        if (orphaned) orphans.push({ entry, formerParent: parentId!, sourceIndex });
        else {
          const list = children.get(parentId) ?? [];
          list.push(entry);
          children.set(parentId, list);
        }
      }
    };
    projectOrder(null);
    const parents = new Set<string>();
    for (const placement of this.#placements.values())
      if (validPlacement(placement) && placement.parentId !== null) parents.add(placement.parentId);
    for (const parent of [...parents].sort(compareIds)) projectOrder(parent);
    const attach = (entry: MinesCatalogEntry): MinesCatalogEntry => ({
      ...entry,
      children: (children.get(entry.entity.id) ?? []).map(attach),
    });
    const orphanRoots = orphans
      .sort(
        (a, b) =>
          compareIds(a.formerParent, b.formerParent) ||
          a.sourceIndex - b.sourceIndex ||
          compareIds(a.entry.entity.id, b.entry.entity.id),
      )
      .map(({ entry }) => entry);
    const roots = [...(children.get(null) ?? []), ...orphanRoots].map(attach);
    const pins: MinesCatalogEntry[] = [];
    const seenPins = new Set<string>();
    for (const ref of this.document.getArray<OrderedReference>("pin-order").toArray()) {
      if (
        !validReference(ref) ||
        seenPins.has(ref.entityId) ||
        this.#pins.get(ref.entityId) !== ref.placementId
      )
        continue;
      const entry = entries.get(ref.entityId);
      if (entry) {
        pins.push(attach(entry));
        seenPins.add(ref.entityId);
      }
    }
    const sourcesByOwner = new Map<string, MinesCatalogContextSource[]>();
    for (const [id, value] of this.#contextSources) {
      if (!value || !entities.has(value.entityId) || this.#contextSourcesDeleted.has(id)) continue;
      const source = decodeSource(value);
      if (Option.isNone(source) || source.value.id !== id) continue;
      try {
        normalizeCatalogSourcePath(source.value.path);
      } catch {
        continue;
      }
      const sources = sourcesByOwner.get(value.entityId) ?? [];
      sources.push(source.value);
      sourcesByOwner.set(value.entityId, sources);
    }
    const contexts: MinesCatalogContext[] = [];
    for (const entity of entities.values()) {
      if (entity.kind !== "project" && entity.kind !== "section") continue;
      const storedInstructions = this.#contextInstructions.get(entity.id);
      const instructions =
        typeof storedInstructions === "string" && storedInstructions.length <= 32_768
          ? storedInstructions
          : "";
      const seenSources = new Set<string>();
      const sources = (sourcesByOwner.get(entity.id) ?? [])
        .sort((a, b) => compareIds(a.id, b.id))
        .filter((source) => {
          const key = JSON.stringify([source.environmentId, source.kind, source.path]);
          if (seenSources.has(key)) return false;
          seenSources.add(key);
          return true;
        });
      if (instructions || sources.length > 0)
        contexts.push({
          entityId: entity.id,
          instructions,
          sources,
        });
    }
    return {
      version: this.#version,
      roots,
      pins,
      entities: [...entities.values()].sort((a, b) => compareIds(a.id, b.id)),
      contexts: contexts.sort((a, b) => compareIds(a.entityId, b.entityId)),
    };
  }

  destroy() {
    this.document.off("afterTransaction", this.#changed);
    this.#listeners.clear();
    this.document.destroy();
  }
}
