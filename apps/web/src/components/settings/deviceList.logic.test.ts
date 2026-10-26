import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";

import { buildDeviceList } from "./deviceList.logic";

const ovh: PeerDevice = {
  deviceId: "ovh-device-123456",
  publicKey: "a".repeat(43),
  label: "OVH",
};

function environment(input: {
  id?: string;
  name?: string;
  peerDeviceId?: string;
  phase?: EnvironmentConnectionPhase;
  enabled?: boolean;
}) {
  const environmentId = EnvironmentId.make(input.id ?? "ovh");
  const label = input.name ?? "OVH";
  const connectionId = `peer:${environmentId}`;
  return {
    environmentId,
    label,
    entry: {
      target: new BearerConnectionTarget({ environmentId, label, connectionId }),
      profile: Option.some(
        new BearerConnectionProfile({
          environmentId,
          label,
          connectionId,
          httpBaseUrl: "https://host.example.test",
          wsBaseUrl: "wss://host.example.test",
          ...(input.peerDeviceId ? { peerDeviceId: input.peerDeviceId } : {}),
        }),
      ),
      enabled: input.enabled ?? true,
    },
    connection: { phase: input.phase ?? "available", error: null, traceId: null },
  };
}

it("shows a newly registered OVH device before a route has been paired", () => {
  expect(
    buildDeviceList({
      environments: [],
      directory: { devices: [ovh], presence: [{ deviceId: ovh.deviceId, online: true }] },
    }),
  ).toEqual([
    {
      id: `device:${ovh.deviceId}`,
      name: "OVH",
      accountDeviceId: ovh.deviceId,
      device: ovh,
      local: false,
      status: "needs-approval",
      presence: "online",
    },
  ]);
});

it("merges a paired account device into its environment by identity", () => {
  const saved = environment({ peerDeviceId: ovh.deviceId, phase: "connected", name: "Server" });
  const rows = buildDeviceList({
    environments: [saved],
    directory: { devices: [ovh], presence: [{ deviceId: ovh.deviceId, online: false }] },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    name: "Server",
    environmentId: saved.environmentId,
    accountDeviceId: ovh.deviceId,
    device: ovh,
    status: "connected",
    presence: "offline",
  });
});

it("merges an SSH computer with its account entry using the reported device identity", () => {
  const saved = environment({ id: "ssh-ovh", name: "mind", phase: "connected" });
  const ssh = {
    ...saved,
    entry: {
      ...saved.entry,
      target: new SshConnectionTarget({
        environmentId: saved.environmentId,
        label: saved.label,
        connectionId: "ssh-ovh",
      }),
      profile: Option.none(),
    },
  };
  const other = { ...ovh, deviceId: "different-device-1234", label: "mind" };
  const rows = buildDeviceList({
    environments: [ssh],
    environmentDevices: new Map([[ssh.environmentId, ovh]]),
    directory: { devices: [ovh, other], presence: [{ deviceId: ovh.deviceId, online: true }] },
  });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    environmentId: ssh.environmentId,
    accountDeviceId: ovh.deviceId,
    status: "connected",
    name: "mind",
  });
  expect(rows[1]).toMatchObject({ accountDeviceId: other.deviceId, status: "needs-approval" });
});

it("finds a paired identity on an alternate route", () => {
  const saved = environment({ peerDeviceId: ovh.deviceId });
  const relay = {
    ...saved,
    entry: {
      ...saved.entry,
      target: new RelayConnectionTarget({ environmentId: saved.environmentId, label: saved.label }),
      profile: Option.none(),
      alternateRoutes: [{ target: saved.entry.target, profile: saved.entry.profile }],
    },
  };
  const rows = buildDeviceList({ environments: [relay], directory: { devices: [ovh] } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ accountDeviceId: ovh.deviceId, device: ovh });
});

it("keeps different devices with the same name separate", () => {
  const rows = buildDeviceList({
    environments: [environment({ name: "OVH" })],
    directory: { devices: [ovh] },
  });
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.name)).toEqual(["OVH", "OVH"]);
});

it("requires a live session for Connected and gives disabled routes priority", () => {
  const phases = [
    ["available", "not-connected"],
    ["offline", "not-connected"],
    ["connecting", "connecting"],
    ["reconnecting", "connecting"],
    ["error", "unavailable"],
    ["unsupported", "unavailable"],
    ["connected", "connected"],
  ] as const;
  for (const [phase, status] of phases) {
    expect(
      buildDeviceList({
        environments: [environment({ peerDeviceId: ovh.deviceId, phase })],
        directory: { devices: [ovh], presence: [{ deviceId: ovh.deviceId, online: true }] },
      })[0]?.status,
    ).toBe(status);
  }
  expect(
    buildDeviceList({ environments: [environment({ enabled: false, phase: "connected" })] })[0]
      ?.status,
  ).toBe("disabled");
});

it("excludes the current environment and both of its account identities from other devices", () => {
  const browser = { ...ovh, deviceId: "browser-device-123456", label: "This browser" };
  const host = { ...ovh, deviceId: "host-device-123456", label: "This Mac" };
  const saved = environment({ id: "local", name: "This Mac" });
  const local = {
    ...saved,
    entry: {
      ...saved.entry,
      target: new PrimaryConnectionTarget({
        environmentId: saved.environmentId,
        label: saved.label,
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
      }),
      profile: Option.none(),
    },
  };
  const rows = buildDeviceList({
    environments: [local],
    directory: { devices: [browser, host, ovh] },
    localDeviceIds: [browser.deviceId, host.deviceId],
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ accountDeviceId: ovh.deviceId, local: false });
});

it("distinguishes old unnamed devices without inventing their computer names", () => {
  const second = { ...ovh, deviceId: "other-device-654321", label: "Mines computer" };
  const rows = buildDeviceList({
    environments: [],
    directory: { devices: [{ ...ovh, label: "Mines computer" }, second] },
  });
  expect(rows.map((row) => row.name)).toEqual([
    "Unknown device · 123456",
    "Unknown device · 654321",
  ]);
});

it("refreshes a generic saved environment label from its account device name", () => {
  const rows = buildDeviceList({
    environments: [environment({ name: "Mines computer", peerDeviceId: ovh.deviceId })],
    directory: { devices: [ovh] },
  });
  expect(rows[0]?.name).toBe("OVH");
});

it("retains registered device platforms before and after pairing", () => {
  const devices = (["macos", "windows", "linux", "ios", "android"] as const).map(
    (platform, index) => ({
      ...ovh,
      deviceId: `platform-device-${index}`,
      platform,
    }),
  );
  const rows = buildDeviceList({
    environments: [environment({ peerDeviceId: devices[0]!.deviceId })],
    directory: { devices },
  });
  expect(rows.map((row) => row.platform)).toEqual(["macos", "windows", "linux", "ios", "android"]);
});

it("keeps missing presence unknown for old account directories", () => {
  expect(buildDeviceList({ environments: [], directory: { devices: [ovh] } })[0]).toMatchObject({
    status: "needs-approval",
    presence: "unknown",
  });
  expect(
    buildDeviceList({
      environments: [environment({ peerDeviceId: ovh.deviceId })],
      directory: { devices: [ovh], presence: [] },
    })[0],
  ).toMatchObject({ status: "not-connected", presence: "unknown" });
});
