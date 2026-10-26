import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { MinesCatalog, catalogHostId } from "@t3tools/client-runtime/catalog";
import { render } from "../../../test/render";
import { MinesCatalogTree } from "./MinesCatalogTree";
import { catalogWorkgroupId } from "./MinesCatalogTree.logic";
import "~/index.css";

const state = vi.hoisted(() => ({
  catalog: null as MinesCatalog | null,
  groups: [] as {
    key: string;
    groupName: string;
    coordinatorEnvironmentId: string;
    groupId: string;
  }[],
  resolved: true,
  empty: [],
  emptyMap: new Map(),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => new Set(["local"]),
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => null } }));
vi.mock("../../catalog/useMinesCatalog", () => ({
  useMinesCatalog: () => {
    const catalog = state.catalog!;
    return {
      catalog,
      snapshot: useSyncExternalStore(catalog.subscribe, catalog.getSnapshot),
      error: null,
      accountId: "local-device",
      flush: async () => {},
    };
  },
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.empty,
  useQuietThreadShells: () => state.empty,
  useServerConfigs: () => state.emptyMap,
}));
vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => state.empty,
  useEnvironmentIdentities: () => state.empty,
  usePrimaryEnvironmentId: () => "local",
  useEnvironments: () => ({ presentationById: state.emptyMap }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/groups", () => ({ groupList: vi.fn() }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { archive: {}, unarchive: {} } }));
vi.mock("../../state/shell", () => ({ liveShellEnvironmentIdsAtom: {} }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: vi.fn(),
}));
vi.mock("../../catalog/CatalogLocalSync", () => ({ CatalogLocalSync: () => null }));
vi.mock("../cloud/CloudCatalogDevices", () => ({ CloudCatalogDevices: () => null }));
vi.mock("../groups/GroupMembershipIndicator", () => ({ GroupMembershipIndicator: () => null }));
vi.mock("../contacts/ContactsProvider", () => ({
  useContactGroupsSnapshot: () => (state.resolved ? { groups: state.groups } : null),
  useContactInvitationCount: () => 0,
}));
vi.mock("./CatalogContextDialog", () => ({ CatalogContextDialog: () => null }));
vi.mock("../chat/mineTransferAvailability", () => ({ canTransferMineAtom: () => ({}) }));
vi.mock("../chat/mineTransferDialogState", () => ({ openMineTransferDialog: vi.fn() }));

function setup() {
  state.catalog = new MinesCatalog();
  state.resolved = true;
  state.groups = [
    { key: "friends", groupName: "Friends", coordinatorEnvironmentId: "peer", groupId: "group" },
  ];
  const section = state.catalog.createSection("Personal section");
  state.catalog.upsert(
    { id: "personal-mine", kind: "thread", title: "Personal mine" },
    { parentId: section },
  );
  state.catalog.upsert({
    id: "local-device",
    kind: "device",
    title: "This Mac",
    hostRef: { environmentId: "local", entityId: "local" },
  });
  state.catalog.pin("personal-mine");
  return state.catalog;
}

it("repeatedly filters the sidebar without navigating and keeps group pins in both modes", async () => {
  const catalog = setup();
  await using screen = await render(
    <MinesCatalogTree onActivateThread={vi.fn()} activeThreadKey={null} />,
  );
  const toggle = screen.getByRole("button", { name: "Workgroups", exact: true });
  const pins = screen.getByRole("list", { name: "Pinned items" });
  await expect.element(screen.getByText("Personal section", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("This Mac", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByText("Personal section", { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("list", { name: "Workgroups" }).getByText("Friends", { exact: true }))
    .toBeVisible();
  await userEvent.hover(
    screen.getByRole("list", { name: "Workgroups" }).getByText("Friends", { exact: true }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Arrange Friends", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Pin", exact: true }));
  expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual([
    "personal-mine",
    catalogWorkgroupId("friends"),
  ]);
  for (const mode of ["personal", "workgroups", "personal"]) {
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("aria-pressed", String(mode === "workgroups"));
    await expect.element(pins.getByText("Friends", { exact: true })).toBeVisible();
    await expect.element(pins.getByText("Personal mine", { exact: true })).toBeVisible();
    expect(screen.router!.state.location.pathname).toBe("/");
  }
});

it("retains unloaded group pins but hides revoked membership once contacts resolve", async () => {
  const catalog = setup();
  catalog.upsert({ id: catalogWorkgroupId("former"), kind: "group", title: "Former group" });
  catalog.pin(catalogWorkgroupId("former"));
  state.resolved = false;
  await using screen = await render(
    <MinesCatalogTree onActivateThread={vi.fn()} activeThreadKey={null} />,
  );
  await expect
    .element(screen.getByRole("list", { name: "Pinned items" }).getByText("Former group"))
    .toBeVisible();
  state.resolved = true;
  await screen.rerender(<MinesCatalogTree onActivateThread={vi.fn()} activeThreadKey={null} />);
  await expect.element(screen.getByText("Former group")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Workgroups", exact: true }));
  await expect.element(screen.getByText("Former group")).not.toBeInTheDocument();
  expect(catalog.getEntity(catalogWorkgroupId("former"))?.title).toBe("Former group");
});

it("transfers legacy group pins once and permits unpinning after migration", async () => {
  const catalog = setup();
  const legacyId = catalogHostId("group", "peer", "group");
  catalog.upsert({
    id: legacyId,
    kind: "group",
    title: "Old Friends",
    hostRef: { environmentId: "peer", entityId: "group" },
  });
  catalog.pin(legacyId);
  await using screen = await render(
    <MinesCatalogTree onActivateThread={vi.fn()} activeThreadKey={null} />,
  );
  const pins = screen.getByRole("list", { name: "Pinned items" });
  await expect.element(pins.getByText("Friends", { exact: true })).toBeVisible();
  expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).not.toContain(legacyId);
  await userEvent.hover(pins.getByText("Friends", { exact: true }));
  await userEvent.click(pins.getByRole("button", { name: "Arrange Friends", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Unpin", exact: true }));
  await expect.element(pins.getByText("Friends", { exact: true })).not.toBeInTheDocument();
  await screen.rerender(<MinesCatalogTree onActivateThread={vi.fn()} activeThreadKey={null} />);
  expect(catalog.getSnapshot().pins.map((entry) => entry.entity.id)).toEqual(["personal-mine"]);
  expect(catalog.getEntity(legacyId)).toBeDefined();
});
