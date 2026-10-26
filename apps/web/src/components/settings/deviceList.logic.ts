import { connectionRoutes } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  PeerDevice,
  PeerDeviceDirectory,
  PeerDevicePlatform,
} from "@t3tools/contracts/minesPeer";
import * as Option from "effect/Option";

import type { EnvironmentPresentation } from "../../state/environments";

type DeviceEnvironment = Pick<
  EnvironmentPresentation,
  "environmentId" | "label" | "entry" | "connection"
> &
  Partial<Pick<EnvironmentPresentation, "serverConfig">>;

export interface DeviceListRow {
  readonly id: string;
  readonly name: string;
  readonly environmentId?: EnvironmentId;
  readonly accountDeviceId?: string;
  readonly device?: PeerDevice;
  readonly platform?: PeerDevicePlatform;
  readonly local: boolean;
  readonly status:
    | "connected"
    | "connecting"
    | "not-connected"
    | "disabled"
    | "unavailable"
    | "needs-approval";
  readonly presence?: "online" | "offline" | "unknown";
}

function isGenericDeviceName(name: string) {
  return /^(?:mines (?:computer|desktop client|browser client)|this (?:computer|device))$/i.test(
    name.trim(),
  );
}

function deviceName(device: PeerDevice) {
  return isGenericDeviceName(device.label)
    ? `Unknown device · ${device.deviceId.slice(-6)}`
    : device.label;
}

function environmentPlatform(environment: DeviceEnvironment): PeerDevicePlatform | undefined {
  switch (environment.serverConfig?.environment.platform.os) {
    case "darwin":
      return "macos";
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

function environmentStatus(environment: DeviceEnvironment): DeviceListRow["status"] {
  if (!environment.entry.enabled) return "disabled";
  switch (environment.connection.phase) {
    case "connected":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "error":
    case "unsupported":
      return "unavailable";
    case "available":
    case "offline":
      return "not-connected";
  }
}

export function buildDeviceList(input: {
  readonly environments: readonly DeviceEnvironment[];
  readonly directory?:
    | (Pick<PeerDeviceDirectory, "devices"> & Partial<Pick<PeerDeviceDirectory, "presence">>)
    | null;
  readonly localDeviceIds?: readonly string[];
  readonly environmentDevices?: ReadonlyMap<EnvironmentId, PeerDevice>;
}): readonly DeviceListRow[] {
  const devices = new Map(input.directory?.devices.map((device) => [device.deviceId, device]));
  const presence = new Map(
    input.directory?.presence?.map((device) => [device.deviceId, device.online]),
  );
  const localIds = new Set(input.localDeviceIds);
  const matchedIds = new Set<string>();
  const devicePresence = (deviceId: string): NonNullable<DeviceListRow["presence"]> => {
    const online = presence.get(deviceId);
    return online === undefined ? "unknown" : online ? "online" : "offline";
  };
  const rows: DeviceListRow[] = input.environments.map((environment) => {
    const reportedDevice = input.environmentDevices?.get(environment.environmentId);
    const peerIds = connectionRoutes(environment.entry).flatMap((route) => {
      const profile = Option.getOrNull(route.profile);
      return profile?._tag === "BearerConnectionProfile" && profile.peerDeviceId
        ? [profile.peerDeviceId]
        : [];
    });
    if (reportedDevice) peerIds.push(reportedDevice.deviceId);
    for (const deviceId of peerIds) matchedIds.add(deviceId);
    const accountDeviceId = peerIds.find((deviceId) => devices.has(deviceId)) ?? peerIds[0];
    const device = (accountDeviceId ? devices.get(accountDeviceId) : undefined) ?? reportedDevice;
    const platform = device?.platform ?? environmentPlatform(environment);
    return {
      id: `environment:${environment.environmentId}`,
      name:
        device && isGenericDeviceName(environment.label) ? deviceName(device) : environment.label,
      environmentId: environment.environmentId,
      ...(accountDeviceId ? { accountDeviceId, presence: devicePresence(accountDeviceId) } : {}),
      ...(device ? { device } : {}),
      ...(platform ? { platform } : {}),
      local:
        environment.entry.target._tag === "PrimaryConnectionTarget" ||
        peerIds.some((deviceId) => localIds.has(deviceId)),
      status: environmentStatus(environment),
    };
  });
  for (const device of devices.values()) {
    if (localIds.has(device.deviceId) || matchedIds.has(device.deviceId)) continue;
    rows.push({
      id: `device:${device.deviceId}`,
      name: deviceName(device),
      accountDeviceId: device.deviceId,
      device,
      ...(device.platform ? { platform: device.platform } : {}),
      local: false,
      status: "needs-approval",
      presence: devicePresence(device.deviceId),
    });
  }
  return rows.filter((row) => !row.local);
}
