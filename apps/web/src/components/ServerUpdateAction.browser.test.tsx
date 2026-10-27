import { RegistryContext } from "@effect/atom-react";
import { AuthSessionState, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  clipboard: vi.fn(),
  continueThreadsAfterServerUpdate: false,
  sessionAtom: null as unknown,
}));

vi.mock(import("~/hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  useCopyToClipboard: ((options: { onCopy: (context: { command: string }) => void }) => ({
    copyToClipboard: (command: string, context: { command: string }) => {
      testState.clipboard(command);
      options.onCopy(context);
    },
    isCopied: false,
  })) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) =>
    selector({
      continueThreadsAfterServerUpdate: testState.continueThreadsAfterServerUpdate,
    })) as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => testState.sessionAtom) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import { resetConfirmDialogForTests } from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import type { EnvironmentPresentation } from "~/state/environments";
import { DeviceCliUpdateAction } from "./settings/DeviceCliUpdateAction";
import {
  ServerUpdateAction,
  ServerUpdatesAction,
  ServerVersionInfo,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

describe("ServerVersionInfo", () => {
  it("opens the installed version on hover", async () => {
    await using screen = await render(<ServerVersionInfo version="0.1.1245" serverLabel="mind" />);
    await userEvent.hover(screen.getByRole("button", { name: "Version information for mind" }));
    await expect.element(page.getByRole("tooltip")).toBeVisible();
    await expect.element(page.getByText("L'appareil est à jour", { exact: true })).toBeVisible();
    await expect.element(page.getByText("v0.1.1245", { exact: true })).toBeVisible();
  });

  it("opens on click and follows the actual version after an update", async () => {
    await using screen = await render(<ServerVersionInfo version="0.1.1245" serverLabel="mind" />);
    await click(screen);
    await expect.element(page.getByRole("tooltip")).toBeVisible();
    await expect.element(page.getByText("v0.1.1245", { exact: true })).toBeVisible();
    await screen.rerender(<ServerVersionInfo version="0.1.1246" serverLabel="mind" />);
    await expect.element(page.getByText("v0.1.1246", { exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
  });
});

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

const legacyAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} as const;

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    ...legacyAuth,
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

const success = (method: "boot-service" | "desktop-app" = "boot-service", version = "0.0.31") =>
  AsyncResult.success({ targetVersion: version, method });

let sessionAtom: Atom.Writable<SessionResult>;

function setSession(session: SessionResult) {
  appAtomRegistry.set(sessionAtom, session);
}

function setup(): Disposable {
  testState.updateServer.mockReset();
  testState.toast.mockReset();
  testState.clipboard.mockReset();
  testState.continueThreadsAfterServerUpdate = false;
  sessionAtom = Atom.make<SessionResult>(AsyncResult.success(currentSession));
  testState.sessionAtom = sessionAtom;
  resetConfirmDialogForTests();
  return { [Symbol.dispose]: resetConfirmDialogForTests };
}

function renderUpdate(element: ReactNode) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>,
  );
}

function button(screen: Screen, name?: string) {
  const buttons = [...screen.container.querySelectorAll("button")];
  return name === undefined
    ? buttons[0]
    : buttons.find((element) => element.textContent?.trim() === name);
}

async function click(screen: Screen, name?: string) {
  await act(async () => button(screen, name)!.click());
}

function renderAction(props: Partial<Parameters<typeof ServerUpdateAction>[0]> = {}) {
  return renderUpdate(
    <ServerUpdateAction
      environmentId={"env-test" as EnvironmentId}
      serverLabel="Test server"
      selfUpdate="boot-service"
      targetVersion="0.0.31"
      {...props}
    />,
  );
}

function deviceElement(version: string | null) {
  const environment = {
    environmentId: "env-device" as EnvironmentId,
    label: "mind",
    entry: { target: { _tag: "SshConnectionTarget" } },
    connection: { phase: version === null ? "offline" : "connected" },
    serverConfig:
      version === null
        ? null
        : {
            environment: {
              serverVersion: version,
              capabilities: { serverSelfUpdate: "boot-service" },
            },
          },
  } as unknown as EnvironmentPresentation;
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <DeviceCliUpdateAction environment={environment} targetVersion="0.1.1246" />
    </RegistryContext.Provider>
  );
}

describe("DeviceCliUpdateAction recovery", () => {
  it.each([
    { version: "0.1.1245", buttonName: "Update CLI for mind" },
    { version: "0.1.1246", buttonName: "Version information for mind" },
  ])(
    "restores $buttonName after reconnecting with a failed update",
    async ({ version, buttonName }) => {
      using _state = setup();
      const updateState = Atom.make<ServerUpdateState>({
        status: "failed",
        stage: "resuming",
        fromVersion: "0.1.1245",
        targetVersion: "0.1.1246",
        message: "Connection interrupted during update.",
      });
      using _updateState = vi
        .spyOn(serverEnvironment, "updateStateAtom")
        .mockReturnValue(updateState);
      await using screen = await render(deviceElement(null));
      await expect.element(screen.getByRole("alert")).toBeVisible();
      await screen.rerender(deviceElement(version));
      await expect.element(screen.getByRole("button", { name: buttonName })).toBeEnabled();
    },
  );
});

describe("ServerUpdateAction", () => {
  it.each([
    { serverUpdateScope: undefined, scopes: ["orchestration:operate"], allowed: true },
    { serverUpdateScope: undefined, scopes: ["orchestration:read"], allowed: false },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["orchestration:operate"],
      allowed: false,
    },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["environment:maintain"],
      allowed: true,
    },
  ] as const)(
    "uses the advertised update scope $serverUpdateScope with grant $scopes",
    async ({ serverUpdateScope, scopes, allowed }) => {
      using _state = setup();
      setSession(
        AsyncResult.success(
          decodeSessionState({
            ...currentSession,
            scopes,
            auth: {
              ...legacyAuth,
              ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
            },
          }),
        ),
      );
      testState.updateServer.mockResolvedValue(success());

      await using screen = await renderAction();
      expect(button(screen, "Update")!.disabled).toBe(!allowed);
      await click(screen, "Update");

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("disables the action once maintenance access is removed", async () => {
    using _state = setup();
    await using screen = await renderAction();
    await act(() => setSession(AsyncResult.success({ ...currentSession, scopes: [] })));
    expect(button(screen, "Update")!.disabled).toBe(true);
    await click(screen, "Update");
    expect(testState.updateServer).not.toHaveBeenCalled();
  });
});

describe("ServerUpdatesAction", () => {
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: true,
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: false,
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];

  const mount = (batch = targets) => renderUpdate(<ServerUpdatesAction targets={batch} />);

  it("names a failed machine while letting the other machine complete", async () => {
    using _state = setup();
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });
});
