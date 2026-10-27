import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

interface Query {
  readonly data: unknown;
  readonly error: string | null;
  readonly isPending: boolean;
}
const state = vi.hoisted(() => ({
  trust: null as unknown as Atom.Writable<Query>,
  requests: null as unknown as Atom.Writable<Query>,
  connection: null as unknown as Atom.Writable<Query>,
  update: null as unknown as Atom.Writable<ServerUpdateState>,
}));
vi.mock("../../cloud/MinesAuthProvider", () => ({
  useMinesAuth: () => ({ isSignedIn: true, userId: "account-a", getToken: vi.fn() }),
}));
vi.mock("../clerk/useMinesAuthPrompt", () => ({
  useMinesAuthPrompt: () => ({ openAuthPrompt: vi.fn() }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateStateAtom: () => state.update },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/peers", () => ({
  peerState: () => "trust",
  peerConnectionState: () => "connection",
  peerPairingRequests: () => "requests",
  peerApprovePairing: {},
  peerConfigure: {},
  peerDenyPairing: {},
  peerDisable: {},
  peerRevoke: {},
}));
vi.mock("../../state/query", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useEnvironmentQuery: (query: "trust" | "connection" | "requests") => ({
      ...useAtomValue(state[query]),
      refresh: vi.fn(),
    }),
  };
});
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    title,
    children,
    headerAction,
  }: {
    title: ReactNode;
    children: ReactNode;
    headerAction: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));

import { ThisComputerAccess } from "./ThisComputerAccess";

const environmentId = EnvironmentId.make("computer-a");
const emptyMessage = "No other devices have access yet. Connection requests will appear here.";
function setup() {
  state.trust = Atom.make<Query>({
    data: { device: { deviceId: "device-a" }, approvedDevices: [] },
    error: null,
    isPending: false,
  });
  state.requests = Atom.make<Query>({ data: [], error: null, isPending: false });
  state.connection = Atom.make<Query>({
    data: { configured: true, online: true, accountId: "account-a" },
    error: null,
    isPending: false,
  });
  state.update = Atom.make<ServerUpdateState>({ status: "idle" });
  const registry = AtomRegistry.make();
  return {
    registry,
    ui: (
      <RegistryContext value={registry}>
        <ThisComputerAccess environmentId={environmentId} name="This Mac" />
      </RegistryContext>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("keeps the empty access state visible during repeated background refreshes", async () => {
  using f = setup();
  await using screen = await render(f.ui);
  await expect.element(screen.getByText(emptyMessage)).toBeVisible();
  for (const isPending of [true, false, true, false]) {
    await act(() => {
      f.registry.set(state.requests, { ...f.registry.get(state.requests), isPending });
      f.registry.set(state.trust, { ...f.registry.get(state.trust), isPending });
    });
    await expect.element(screen.getByText(emptyMessage)).toBeVisible();
  }
});

it("waits for both access lists before claiming there are no devices", async () => {
  using f = setup();
  f.registry.set(state.trust, { data: null, error: null, isPending: true });
  f.registry.set(state.requests, { data: null, error: null, isPending: true });
  await using screen = await render(f.ui);
  await expect.element(screen.getByText(emptyMessage)).not.toBeInTheDocument();
  await act(() => f.registry.set(state.requests, { data: [], error: null, isPending: false }));
  await expect.element(screen.getByText(emptyMessage)).not.toBeInTheDocument();
  await act(() =>
    f.registry.set(state.trust, {
      data: { device: { deviceId: "device-a" }, approvedDevices: [] },
      error: null,
      isPending: false,
    }),
  );
  await expect.element(screen.getByText(emptyMessage)).toBeVisible();
});

it("offers reconnect only after an interrupted update has finished", async () => {
  using f = setup();
  f.registry.set(state.connection, {
    data: { configured: true, online: false, accountId: "account-a" },
    error: null,
    isPending: false,
  });
  f.registry.set(state.update, {
    status: "running",
    stage: "resuming",
    fromVersion: "0.1.8",
    targetVersion: "0.1.9",
  });
  await using screen = await render(f.ui);
  await expect
    .element(screen.getByRole("button", { name: "Reconnect", exact: true }))
    .not.toBeInTheDocument();
  await act(() =>
    f.registry.set(state.update, {
      status: "failed",
      stage: "resuming",
      fromVersion: "0.1.8",
      targetVersion: "0.1.9",
      message: "Connection interrupted",
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Reconnect", exact: true }))
    .toBeVisible();
});
