import { describe, expect, it } from "vite-plus/test";
import { MinesCatalog, catalogHostId } from "./index.ts";
import {
  connectCatalogPeer,
  createAtomicCatalogStorage,
  openPersistedCatalog,
  type EncryptedCatalogStorage,
} from "./persistence.ts";

function replica(device: string) {
  let next = 0;
  return new MinesCatalog({ createId: () => `${device}-${++next}` });
}

function sync(a: MinesCatalog, b: MinesCatalog) {
  const aDiff = a.encodeUpdate(b.encodeStateVector());
  const bDiff = b.encodeUpdate(a.encodeStateVector());
  a.applyUpdate(bDiff);
  b.applyUpdate(aDiff);
}

it("syncs imported subagent containment and rejects a descendant placement cycle", () => {
  const host = replica("host");
  host.upsert({ id: "root", kind: "thread", title: "Conversation" });
  host.upsert(
    {
      id: "child",
      kind: "thread",
      title: "Subagent",
      importSource: {
        executionProjectId: "execution",
        sourceProject: null,
        kind: "subagent",
        agentName: "Ada",
      },
    },
    { parentId: "root" },
  );
  host.upsert({ id: "grandchild", kind: "thread", title: "Worker" }, { parentId: "child" });
  expect(() => host.move("root", "grandchild")).toThrow("cycle");
  const peer = replica("phone");
  sync(host, peer);
  expect(peer.getSnapshot().roots[0]?.children[0]?.entity.importSource?.agentName).toBe("Ada");
  expect(peer.getSnapshot().roots[0]?.children[0]?.children[0]?.entity.id).toBe("grandchild");
});

it("keeps authoritative archive state across stale replicas and restores the same pin order", () => {
  const host = replica("host");
  seed(host);
  host.pin("a");
  host.pin("b");
  const stale = replica("phone");
  sync(host, stale);
  host.applyHostLifecycle({ id: "a", sequence: 10, state: "archived" });
  sync(host, stale);
  expect(host.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual(["b"]);
  host.applyHostLifecycle({ id: "a", sequence: 12, state: "active" });
  stale.applyHostLifecycle({ id: "a", sequence: 11, state: "archived" });
  stale.upsert({ id: "a", kind: "thread", title: "Stale title" });
  sync(host, stale);
  expect(outline(host)).toEqual(outline(stale));
  expect(host.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual(["a", "b"]);
});

it("never resurrects an authoritative deletion from a stale upsert or later active event", () => {
  const host = replica("host");
  seed(host);
  const stale = replica("phone");
  sync(host, stale);
  host.applyHostLifecycle({ id: "a", sequence: 10, state: "deleted" });
  stale.pin("a");
  stale.upsert({ id: "a", kind: "thread", title: "Stale" });
  stale.applyHostLifecycle({ id: "a", sequence: 20, state: "active" });
  sync(host, stale);
  expect(outline(host)).toEqual(outline(stale));
  expect(host.has("a")).toBe(false);
  expect(host.getSnapshot().pins).toEqual([]);
});

it("applies host lifecycle before discovery and preserves deleted project children", () => {
  const catalog = replica("host");
  catalog.applyHostLifecycle({ id: "a", sequence: 1, state: "archived" });
  seed(catalog);
  expect(catalog.getSnapshot().entities.some((entity) => entity.id === "a")).toBe(false);
  catalog.applyHostLifecycle({ id: "a", sequence: 2, state: "active" });
  catalog.applyHostLifecycle({ id: "project", sequence: 3, state: "deleted" });
  expect(
    catalog
      .getSnapshot()
      .roots.filter((entry) => entry.orphaned)
      .map((entry) => entry.entity.id),
  ).toEqual(["a", "b"]);
});

it("reconciles cloud devices without deleting their history or pin order", () => {
  const catalog = replica("desktop");
  const cloudId = catalogHostId("device", "host", "cloud:claudeAgent");
  const otherId = catalogHostId("device", "other-host", "cloud:claudeAgent");
  catalog.upsert({
    id: cloudId,
    kind: "device",
    title: "Claude cloud",
    hostRef: { environmentId: "host", entityId: "cloud:claudeAgent" },
  });
  catalog.upsert({
    id: otherId,
    kind: "device",
    title: "Other account",
    hostRef: { environmentId: "other-host", entityId: "cloud:claudeAgent" },
  });
  catalog.upsert({ id: "retained-mine", kind: "thread", title: "Imported mine" });
  catalog.pin(cloudId);
  catalog.pin("retained-mine");
  catalog.reconcileHostDevices({
    environmentId: "host",
    entityPrefix: "cloud:",
    devices: [],
    sequence: 10,
  });
  expect(catalog.has(cloudId)).toBe(true);
  expect(catalog.getSnapshot().entities.map((entity) => entity.id)).toEqual([
    otherId,
    "retained-mine",
  ]);
  catalog.reconcileHostDevices({
    environmentId: "host",
    entityPrefix: "cloud:",
    devices: [{ id: "cloud:claudeAgent", title: "Reconnected account" }],
    sequence: 12,
  });
  expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual([
    cloudId,
    "retained-mine",
  ]);
  catalog.reconcileHostDevices({
    environmentId: "host",
    entityPrefix: "cloud:",
    devices: [],
    sequence: 11,
  });
  expect(catalog.getSnapshot().entities.some((entity) => entity.id === cloudId)).toBe(true);
});

describe("reversible section archive", () => {
  it("archives only the section and restores its contents, context, and pin order", () => {
    const catalog = replica("desktop");
    seed(catalog);
    catalog.pin("work");
    catalog.pin("a");
    catalog.setContextInstructions("work", "Keep the section context");
    const before = catalog.getSnapshot();

    catalog.archiveSection("work", { includeContents: false });

    expect(catalog.has("work")).toBe(true);
    expect(catalog.getArchivedSections().map((entity) => entity.id)).toEqual(["work"]);
    expect(catalog.getSnapshot().roots.map((entry) => entry.entity.id)).toEqual([
      "personal",
      "project",
    ]);
    expect(catalog.getSnapshot().roots[1]?.children.map((entry) => entry.entity.id)).toEqual([
      "a",
      "b",
    ]);
    expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual(["a"]);

    catalog.restoreSection("work");

    expect(catalog.getArchivedSections()).toEqual([]);
    expect(catalog.getSnapshot().roots).toEqual(before.roots);
    expect(catalog.getSnapshot().pins).toEqual(before.pins);
    expect(catalog.getSnapshot().contexts).toEqual(before.contexts);
  });

  it("retains archived descendants and references across discovery, persistence, and repeated restore", () => {
    const catalog = replica("desktop");
    seed(catalog);
    catalog.upsert({ id: "nested", kind: "thread", title: "Subagent" }, { parentId: "a" });
    catalog.pin("project");
    catalog.pin("nested");
    catalog.setContextInstructions("project", "Project context");
    const before = catalog.getSnapshot();

    catalog.archiveSection("work", { includeContents: true });
    catalog.upsert({ id: "a", kind: "thread", title: "Build" });
    const peer = replica("phone");
    peer.applyUpdate(catalog.encodeUpdate());
    peer.applyUpdate(catalog.encodeUpdate());

    expect(peer.getSnapshot().entities.map((entity) => entity.id)).toEqual(["personal"]);
    expect(peer.getSnapshot().pins).toEqual([]);
    for (const id of ["work", "project", "a", "b", "nested"]) expect(peer.has(id)).toBe(true);
    peer.restoreSection("work");
    peer.restoreSection("work");
    expect(peer.getSnapshot().roots).toEqual(before.roots);
    expect(peer.getSnapshot().pins).toEqual(before.pins);
    expect(peer.getSnapshot().contexts).toEqual(before.contexts);
    sync(catalog, peer);
    expect(outline(catalog)).toEqual(outline(peer));
  });

  it("keeps concurrent children archived and leaves unrelated items visible", () => {
    const desktop = replica("desktop");
    const phone = replica("phone");
    seed(desktop);
    sync(desktop, phone);
    desktop.archiveSection("work", { includeContents: true });
    phone.upsert({ id: "new", kind: "thread", title: "Added offline" }, { parentId: "project" });
    phone.upsert(
      { id: "outside", kind: "thread", title: "Personal mine" },
      { parentId: "personal" },
    );
    sync(desktop, phone);

    expect(desktop.getSnapshot().entities.map((entity) => entity.id)).toEqual([
      "outside",
      "personal",
    ]);
    expect(outline(desktop)).toEqual(outline(phone));
    desktop.restoreSection("work");
    sync(desktop, phone);
    expect(
      desktop.getSnapshot().roots[0]?.children[0]?.children.map((entry) => entry.entity.id),
    ).toEqual(["a", "b", "new"]);
  });

  it("retains exactly the host archive references required for restoration", () => {
    const catalog = replica("desktop");
    seed(catalog);
    const archivedThreads = [{ environmentId: "host", threadId: "a" }];
    expect(catalog.getSectionContents("work").map((entity) => entity.id)).toEqual([
      "project",
      "a",
      "b",
    ]);
    catalog.archiveSection("work", { includeContents: true, archivedThreads });
    const restored = replica("restored");
    restored.applyUpdate(catalog.encodeUpdate());
    expect(restored.getArchivedSectionThreads("work")).toEqual(archivedThreads);
    expect(restored.getSectionContents("work").map((entity) => entity.id)).toEqual([
      "project",
      "a",
      "b",
    ]);
    restored.restoreSection("work");
    expect(restored.getArchivedSectionThreads("work")).toEqual([]);
  });

  it("preserves untouched child placements when another archived-section child is moved", () => {
    const catalog = replica("desktop");
    seed(catalog);
    catalog.upsert(
      { id: "second-project", kind: "project", title: "Second" },
      { parentId: "work" },
    );
    catalog.archiveSection("work", { includeContents: false });
    catalog.move("project", null);
    catalog.restoreSection("work");
    expect(catalog.getSnapshot().roots[0]?.children.map((entry) => entry.entity.id)).toEqual([
      "second-project",
    ]);
    expect(catalog.getSnapshot().roots[2]?.entity.id).toBe("project");
  });

  it("ignores malformed peer archive metadata without breaking content or restore", () => {
    const catalog = replica("desktop");
    seed(catalog);
    const before = outline(catalog);
    for (const archive of [
      { sectionId: "work", includeContents: true, entityIds: "work", archivedThreads: {} },
      { sectionId: "work", includeContents: true, entityIds: ["work"], archivedThreads: {} },
      { sectionId: "work", includeContents: true, entityIds: [null], archivedThreads: [] },
      {
        sectionId: "work",
        includeContents: true,
        entityIds: ["work"],
        archivedThreads: [{ threadId: 1 }],
      },
    ]) {
      catalog.document.getMap("section-archives").set("work", archive);
      expect(outline(catalog)).toEqual(before);
      expect(catalog.getArchivedSections()).toEqual([]);
      expect(catalog.getArchivedSectionThreads("work")).toEqual([]);
      expect(catalog.getSectionContents("work").map((entity) => entity.id)).toEqual([
        "project",
        "a",
        "b",
      ]);
      catalog.restoreSection("work");
      expect(outline(catalog)).toEqual(before);
    }
  });

  it("merges concurrent section archives without losing either host recovery journal", () => {
    const desktop = replica("desktop");
    const phone = replica("phone");
    seed(desktop);
    sync(desktop, phone);
    const first = { environmentId: "host-a", threadId: "one" };
    const second = { environmentId: "host-b", threadId: "two" };
    desktop.archiveSection("work", { includeContents: true, archivedThreads: [first] });
    phone.archiveSection("work", { includeContents: true, archivedThreads: [second] });
    sync(desktop, phone);
    expect(desktop.getArchivedSectionThreads("work")).toEqual([first, second]);
    expect(phone.getArchivedSectionThreads("work")).toEqual([first, second]);
    expect(desktop.getArchivedSections().map((section) => section.id)).toEqual(["work"]);
  });

  it("restores only observed archive operations when another archive arrives during host recovery", () => {
    const desktop = replica("desktop");
    const phone = replica("phone");
    seed(desktop);
    sync(desktop, phone);
    const first = { environmentId: "host-a", threadId: "one" };
    const second = { environmentId: "host-b", threadId: "two" };
    desktop.archiveSection("work", { includeContents: true, archivedThreads: [first] });
    const observed = desktop.getSectionArchiveToken("work");
    phone.archiveSection("work", { includeContents: true, archivedThreads: [second] });
    sync(desktop, phone);
    desktop.restoreSection("work", observed);
    sync(desktop, phone);
    expect(desktop.getArchivedSectionThreads("work")).toEqual([second]);
    expect(desktop.getArchivedSections()).toHaveLength(1);
    expect(desktop.getSnapshot().pins).toEqual([]);
    const stale = desktop.encodeUpdate();
    desktop.restoreSection("work", desktop.getSectionArchiveToken("work"));
    desktop.applyUpdate(stale);
    sync(desktop, phone);
    expect(desktop.getArchivedSections()).toEqual([]);
    expect(phone.getArchivedSectionThreads("work")).toEqual([]);
    expect(outline(desktop)).toEqual(outline(phone));
  });

  it("rejects a non-section without changing the document", () => {
    const catalog = replica("desktop");
    seed(catalog);
    const before = catalog.encodeStateVector();
    expect(() => catalog.archiveSection("project", { includeContents: true })).toThrow("section");
    expect(catalog.encodeStateVector()).toEqual(before);
  });
});

function outline(catalog: MinesCatalog) {
  const { roots, pins, entities } = catalog.getSnapshot();
  return { roots, pins, entities };
}

function seed(catalog: MinesCatalog) {
  catalog.upsert({ id: "work", kind: "section", title: "Work" });
  catalog.upsert({ id: "personal", kind: "section", title: "Personal" });
  catalog.upsert({ id: "project", kind: "project", title: "mines" }, { parentId: "work" });
  catalog.upsert({ id: "a", kind: "thread", title: "Build" }, { parentId: "project" });
  catalog.upsert({ id: "b", kind: "group", title: "Review council" }, { parentId: "project" });
}

describe("peer replicated sidebar catalog", () => {
  it("converges concurrent offline moves of one thread without duplicate rows", () => {
    const desktop = replica("desktop");
    const phone = replica("phone");
    seed(desktop);
    sync(desktop, phone);
    desktop.move("a", "personal");
    phone.move("a", null);
    desktop.pin("project");
    phone.pin("a");
    sync(desktop, phone);
    expect(outline(desktop)).toEqual(outline(phone));
    const occurrences = JSON.stringify(desktop.getSnapshot().roots).match(/"id":"a"/g);
    expect(occurrences).toHaveLength(1);
    expect(
      desktop
        .getSnapshot()
        .pins.map((entry) => entry.entity.id)
        .sort(),
    ).toEqual(["a", "project"]);
  });

  it("preserves both concurrent gap insertions and permits a subsequent insertion between them", () => {
    const a = replica("a");
    const b = replica("b");
    seed(a);
    sync(a, b);
    a.upsert({ id: "c", kind: "thread", title: "C" }, { parentId: "project", beforeId: "b" });
    b.upsert({ id: "d", kind: "thread", title: "D" }, { parentId: "project", beforeId: "b" });
    sync(a, b);
    const project = a.getSnapshot().roots[0]!.children[0]!;
    const gap = project.children.filter(
      (entry) => entry.entity.id === "c" || entry.entity.id === "d",
    );
    a.move("a", "project", gap[1]!.entity.id);
    sync(a, b);
    expect(outline(a)).toEqual(outline(b));
    expect(a.getSnapshot().roots[0]!.children[0]!.children.map((entry) => entry.entity.id)).toEqual(
      [gap[0]!.entity.id, "a", gap[1]!.entity.id, "b"],
    );
  });

  it("preserves children when a parent is removed while an offline peer moves a thread into it", () => {
    const a = replica("a");
    const b = replica("b");
    seed(a);
    sync(a, b);
    a.removeContainer("project");
    b.move("a", "project", "b");
    b.pin("a");
    sync(a, b);
    expect(outline(a)).toEqual(outline(b));
    expect(
      a
        .getSnapshot()
        .roots.filter((entry) => entry.orphaned)
        .map((entry) => entry.entity.id),
    ).toEqual(["a", "b"]);
    expect(a.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual(["a"]);
    b.upsert({ id: "project", kind: "project", title: "Stale host project" });
    expect(b.getSnapshot().entities.some((entity) => entity.id === "project")).toBe(false);
  });

  it("keeps deleted ancestors removed across stale renames, pins, moves, and repeated reconnects", () => {
    const a = replica("a");
    const b = replica("b");
    const stale = replica("stale");
    seed(a);
    sync(a, b);
    sync(a, stale);
    const beforeDeletion = stale.encodeUpdate();
    a.removeContainer("work");
    a.removeContainer("project");
    b.move("project", "personal");
    b.rename("work", "Old work");
    b.pin("project");
    stale.move("a", "project", "b");
    stale.pin("work");
    stale.pin("a");
    stale.rename("a", "Updated conversation");
    sync(a, b);
    sync(b, stale);
    sync(stale, a);
    for (const catalog of [a, b, stale]) {
      catalog.applyUpdate(beforeDeletion);
      catalog.applyUpdate(beforeDeletion);
      catalog.upsert({ id: "project", kind: "project", title: "Host rediscovered project" });
      expect(outline(catalog)).toEqual(outline(a));
      expect(catalog.getSnapshot().entities.map((entity) => entity.id)).toEqual([
        "a",
        "b",
        "personal",
      ]);
      expect(
        catalog
          .getSnapshot()
          .roots.map((entry) => entry.entity.id)
          .sort(),
      ).toEqual(["a", "b", "personal"]);
      expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual(["a"]);
      expect(catalog.getSnapshot().entities.find((entity) => entity.id === "a")?.title).toBe(
        "Updated conversation",
      );
    }
  });

  it("does not lose pins on stale reconnect and converges concurrent pin and unpin", () => {
    const a = replica("a");
    const b = replica("b");
    const stale = replica("stale");
    seed(a);
    sync(a, b);
    sync(a, stale);
    a.pin("a");
    b.pin("b");
    sync(a, b);
    sync(a, stale);
    expect(stale.getSnapshot().pins).toHaveLength(2);
    a.unpin("a");
    b.pin("a", "b");
    sync(a, b);
    expect(outline(a)).toEqual(outline(b));
  });

  it("handles duplicated updates and restores durable order without contacting a host", async () => {
    let stored: Uint8Array | null = null;
    const storage: EncryptedCatalogStorage = {
      read: async () => stored,
      write: async (data) => {
        stored = data;
      },
      clear: async () => {
        stored = null;
      },
    };
    const handle = await openPersistedCatalog({ storage, createId: () => "placement" });
    const id = catalogHostId("thread", "sleeping-mac", "thread-1");
    handle.catalog.upsert({
      id,
      kind: "thread",
      title: "Still here",
      hostRef: { environmentId: "sleeping-mac", entityId: "thread-1" },
    });
    handle.catalog.pin(id);
    const expected = outline(handle.catalog);
    await handle.flush();
    await handle.close();
    const restored = await openPersistedCatalog({ storage });
    restored.catalog.applyUpdate(stored!);
    restored.catalog.applyUpdate(stored!);
    expect(outline(restored.catalog)).toEqual(expected);
    await restored.close();
  });

  it("moves a rescued conversation after its former siblings in the manual root order", () => {
    const catalog = replica("desktop");
    seed(catalog);
    catalog.removeContainer("project");
    catalog.move("a", null);
    expect(catalog.getSnapshot().roots.map((entry) => entry.entity.id)).toEqual([
      "work",
      "personal",
      "b",
      "a",
    ]);
  });

  it("rejects section nesting and thread-as-container moves", () => {
    const catalog = replica("a");
    seed(catalog);
    expect(() => catalog.move("work", "personal")).toThrow();
    expect(() => catalog.move("project", "a")).toThrow();
    expect(() => catalog.move("project", "project")).toThrow();
  });
});

describe("catalog transport and persistence", () => {
  it("waits for a peer acknowledgment covering the captured context revision", async () => {
    const local = replica("local");
    const remote = replica("remote");
    const oldVector = local.encodeStateVector();
    local.createSection("New project context");
    const required = local.encodeStateVector();
    let receive!: (frame: Uint8Array) => void;
    const sent = Promise.withResolvers<void>();
    const stop = connectCatalogPeer(local, {
      send: async (frame) => {
        if (frame[0] !== 1) return;
        remote.applyUpdate(frame.subarray(1));
        sent.resolve();
      },
      subscribe: (listener) => {
        receive = listener;
        return () => {};
      },
    });
    let completed = false;
    const flushed = stop.flush(required).then(() => {
      completed = true;
    });
    const acknowledge = (vector: Uint8Array) => {
      const frame = new Uint8Array(vector.byteLength + 1);
      frame[0] = 2;
      frame.set(vector, 1);
      receive(frame);
    };
    acknowledge(oldVector);
    await sent.promise;
    expect(completed).toBe(false);
    expect(remote.getSnapshot().entities[0]?.title).toBe("New project context");
    remote.createSection("Independent remote edit");
    acknowledge(remote.encodeStateVector());
    await flushed;
    expect(completed).toBe(true);
    stop();
    local.destroy();
    remote.destroy();
  });

  it("rejects pending context acknowledgment when its peer closes", async () => {
    const catalog = replica("local");
    catalog.createSection("Pending context");
    const stop = connectCatalogPeer(catalog, {
      send: async () => {},
      subscribe: () => () => {},
    });
    const flushed = stop.flush(catalog.encodeStateVector());
    stop();
    await expect(flushed).rejects.toThrow("connection closed");
    catalog.destroy();
  });

  it("repairs a missed opening handshake and converges both offline catalogs", async () => {
    const desktop = replica("desktop");
    const phone = replica("phone");
    desktop.createSection("From desktop");
    phone.createSection("From phone");
    let toDesktop: ((frame: Uint8Array) => void) | undefined;
    let toPhone: ((frame: Uint8Array) => void) | undefined;
    let opened!: () => void;
    const firstFrame = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let converged!: () => void;
    const synced = new Promise<void>((resolve) => {
      converged = resolve;
    });
    const check = () => {
      if (desktop.getSnapshot().entities.length === 2 && phone.getSnapshot().entities.length === 2)
        converged();
    };
    const stopDesktop = connectCatalogPeer(
      desktop,
      {
        send: async (frame) => {
          toPhone?.(frame);
          opened();
        },
        subscribe: (listener) => {
          toDesktop = listener;
          return () => {
            toDesktop = undefined;
          };
        },
      },
      { onStatus: check },
    );
    await firstFrame;
    const stopPhone = connectCatalogPeer(
      phone,
      {
        send: async (frame) => {
          toDesktop?.(frame);
        },
        subscribe: (listener) => {
          toPhone = listener;
          return () => {
            toPhone = undefined;
          };
        },
      },
      { onStatus: check },
    );
    await synced;
    expect(outline(desktop)).toEqual(outline(phone));
    stopDesktop();
    stopPhone();
  });

  it("merges concurrent stale window snapshots under the shared storage lock", async () => {
    let stored: Uint8Array | null = null;
    let tail: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(operation: () => Promise<T>) => {
      const next = tail.then(operation);
      tail = next.catch(() => {});
      return next;
    };
    const storage = createAtomicCatalogStorage(
      {
        read: async () => stored,
        write: async (snapshot) => {
          stored = snapshot;
        },
        clear: async () => {
          stored = null;
        },
      },
      exclusive,
    );
    const a = await openPersistedCatalog({ storage });
    const b = await openPersistedCatalog({ storage });
    a.catalog.createSection("Window A");
    b.catalog.createSection("Window B");
    await Promise.all([a.flush(), b.flush()]);
    const restored = replica("restored");
    restored.applyUpdate(stored!);
    expect(
      restored
        .getSnapshot()
        .entities.map((entity) => entity.title)
        .sort(),
    ).toEqual(["Window A", "Window B"]);
    expect(outline(b.catalog)).toEqual(outline(restored));
    await Promise.all([a.close(), b.close()]);
  });

  it("persists an edit queued as the previous write completes", async () => {
    let stored: Uint8Array | null = null;
    const handle = await openPersistedCatalog({
      storage: {
        read: async () => stored,
        write: async (snapshot) => {
          stored = snapshot;
        },
        clear: async () => {
          stored = null;
        },
      },
    });
    handle.catalog.createSection("First");
    await Promise.resolve();
    handle.catalog.createSection("Second");
    await handle.flush();
    const restored = replica("restored");
    restored.applyUpdate(stored!);
    expect(
      restored
        .getSnapshot()
        .entities.map((entity) => entity.title)
        .sort(),
    ).toEqual(["First", "Second"]);
    await handle.close();
  });

  it("reports a failed durable write and retries the latest snapshot on a later edit", async () => {
    let reject = true;
    let stored: Uint8Array | null = null;
    const handle = await openPersistedCatalog({
      storage: {
        read: async () => stored,
        write: async (snapshot) => {
          if (reject) throw new Error("Storage full");
          stored = snapshot;
        },
        clear: async () => {
          stored = null;
        },
      },
    });
    handle.catalog.createSection("First");
    await expect(handle.flush()).rejects.toThrow("Storage full");
    expect(handle.getPersistenceError()).toBe("Storage full");
    reject = false;
    handle.catalog.createSection("Second");
    await handle.flush();
    expect(handle.getPersistenceError()).toBeNull();
    const restored = replica("restored");
    restored.applyUpdate(stored!);
    expect(
      restored
        .getSnapshot()
        .entities.map((entity) => entity.title)
        .sort(),
    ).toEqual(["First", "Second"]);
    await handle.close();
  });
});
