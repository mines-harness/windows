import { RegistryContext } from "@effect/atom-react";
import { SshConnectionTarget } from "@t3tools/client-runtime/connection";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  updates: null as unknown as Atom.Writable<readonly ServerUpdateState[]>,
  identities: null as unknown as Atom.Writable<ReadonlyMap<EnvironmentId, PeerDevice>>,
  command: vi.fn(),
}));
vi.mock("../../cloud/MinesAuthProvider", () => ({
  useMinesAuth: () => ({ isSignedIn: true, userId: "account-a", getToken: vi.fn() }),
}));
vi.mock("../../cloud/publicConfig", () => ({
  hasMinesIdentityConfig: () => true,
  minesControlUrl: () => "https://control.example.test",
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../state/server", () => ({ environmentUpdateStatesAtom: () => state.updates }));
vi.mock("../../state/environmentPeerDevices", async () => {
  const { Atom } = await import("effect/reactivity");
  state.identities = Atom.make<ReadonlyMap<EnvironmentId, PeerDevice>>(new Map());
  return { environmentPeerDevicesAtom: state.identities };
});
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { retryNow: {} } }));
vi.mock("../../connection/peerOnboarding", () => ({
  beginPeerPairing: {},
  cancelPeerPairing: {},
  collectPeerPairing: {},
  forgetPeerClient: {},
  peerClientApproval: {},
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("../clerk/useMinesAuthPrompt", () => ({
  useMinesAuthPrompt: () => ({ openAuthPrompt: vi.fn() }),
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("./useAccountPeerDirectory", () => ({
  useAccountPeerDirectory: () => ({ data: null, isPending: false, error: null, refresh: vi.fn() }),
}));
vi.mock("./ThisComputerAccess", () => ({ ThisComputerAccess: () => null }));
vi.mock("./ConnectionsAdvancedSettings", () => ({ ConnectionsAdvancedSettings: () => null }));
vi.mock("./AddSshComputer", () => ({ AddSshComputer: () => null }));
vi.mock("./DeviceCliUpdateAction", () => ({ DeviceCliUpdateAction: () => null }));
vi.mock("./settingsLayout", () => ({
  useSettingsSearchTargetId: () => null,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
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

import { DevicesSettings } from "./DevicesSettings";

it("hides reconnect through each remote update stage and restores it after an interruption", async () => {
  state.command.mockReset().mockResolvedValue({ _tag: "Failure" });
  const environmentId = EnvironmentId.make("mind-test");
  state.environments = [
    {
      environmentId,
      label: "Test server",
      entry: {
        target: new SshConnectionTarget({
          environmentId,
          label: "Test server",
          connectionId: "ssh-test",
        }),
        profile: Option.none(),
        enabled: true,
      },
      connection: { phase: "reconnecting", error: null, traceId: null },
      serverConfig: null,
    },
  ];
  state.updates = Atom.make<readonly ServerUpdateState[]>([
    { status: "running", stage: "downloading", fromVersion: "0.1.8", targetVersion: "0.1.9" },
  ]);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext value={registry}>
      <DevicesSettings />
    </RegistryContext>,
  );
  for (const stage of [
    "downloading",
    "installing",
    "resuming",
    "installing",
    "resuming",
  ] as const) {
    await act(() =>
      registry.set(state.updates, [
        { status: "running", stage, fromVersion: "0.1.8", targetVersion: "0.1.9" },
      ]),
    );
    await expect
      .element(screen.getByRole("button", { name: "Reconnect", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Forget", exact: true }))
      .toBeDisabled();
  }
  await act(() =>
    registry.set(state.updates, [
      {
        status: "failed",
        stage: "resuming",
        fromVersion: "0.1.8",
        targetVersion: "0.1.9",
        message: "Connection interrupted",
      },
    ]),
  );
  await expect
    .element(screen.getByRole("button", { name: "Reconnect", exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Forget", exact: true })).toBeEnabled();
});
