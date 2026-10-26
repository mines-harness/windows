import { useEffect, useEffectEvent, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { PeerDeviceDirectory } from "@t3tools/contracts/minesPeer";

import { useThreadShells } from "../../state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironment,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { peerState } from "../../state/peers";
import { environmentPeerDevicesAtom } from "../../state/environmentPeerDevices";
import { useAtomCommand } from "../../state/use-atom-command";
import { peerClientApproval } from "../../connection/peerOnboarding";
import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { hasMinesIdentityConfig } from "../../cloud/publicConfig";
import { useAccountPeerDirectory } from "../settings/useAccountPeerDirectory";
import { buildDeviceList } from "../settings/deviceList.logic";
import { buildMenuBarState } from "./MenuBarCoordinator.logic";

const NO_DEVICE_IDS: readonly string[] = [];

export function MenuBarCoordinator() {
  return hasMinesIdentityConfig() ? <AccountMenuBarCoordinator /> : <MenuBarContent />;
}

function AccountMenuBarCoordinator() {
  const { userId, isSignedIn } = useMinesAuth();
  return <AccountMenuBarContent key={isSignedIn ? userId : "signed-out"} />;
}

function AccountMenuBarContent() {
  const { userId, isSignedIn } = useMinesAuth();
  const primary = usePrimaryEnvironment();
  const trust = useEnvironmentQuery(
    isSignedIn && primary?.connection.phase === "connected"
      ? peerState({ environmentId: primary.environmentId, input: {} })
      : null,
  );
  const directory = useAccountPeerDirectory();
  const approval = useAtomCommand(peerClientApproval, { reportFailure: false });
  const [clientDeviceId, setClientDeviceId] = useState<string | null>(null);
  const [hostDeviceIds, setHostDeviceIds] = useState<readonly string[]>([]);
  const hostDeviceId = trust.data?.device.deviceId;
  if (hostDeviceId && !hostDeviceIds.includes(hostDeviceId)) {
    setHostDeviceIds([...hostDeviceIds, hostDeviceId]);
  }
  const refreshDirectory = useEffectEvent(directory.refresh);

  useEffect(() => {
    if (!isSignedIn || !userId) return;
    let active = true;
    void approval(userId).then((result) => {
      if (active && AsyncResult.isSuccess(result)) setClientDeviceId(result.value.device.deviceId);
    });
    return () => {
      active = false;
    };
  }, [approval, isSignedIn, userId]);

  useEffect(() => {
    if (!isSignedIn) return;
    let refreshedAt = Date.now();
    const refresh = () => {
      if (document.visibilityState === "hidden" || Date.now() - refreshedAt < 15_000) return;
      refreshedAt = Date.now();
      refreshDirectory();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isSignedIn]);

  return (
    <MenuBarContent
      directory={directory.data}
      localDeviceIds={[...hostDeviceIds, ...(clientDeviceId ? [clientDeviceId] : [])]}
    />
  );
}

function MenuBarContent({
  directory = null,
  localDeviceIds = NO_DEVICE_IDS,
}: {
  readonly directory?: PeerDeviceDirectory | null;
  readonly localDeviceIds?: readonly string[];
}) {
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const navigate = useNavigate();
  const environmentDevices = useAtomValue(environmentPeerDevicesAtom);
  const devices = buildDeviceList({ environments, directory, localDeviceIds, environmentDevices });
  const state = buildMenuBarState({
    threads,
    providers: [...providers.values()].flat(),
    connectedDevices: devices.filter((device) => device.status === "connected").length,
    totalDevices: devices.length,
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      connected: device.status === "connected",
      local: device.local,
      status: device.status,
      ...(device.presence ? { presence: device.presence } : {}),
    })),
  });
  const serialized = JSON.stringify(state);

  useEffect(() => {
    void window.desktopBridge?.setMenuBarState?.(JSON.parse(serialized)).catch(() => undefined);
  }, [serialized]);

  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action === "mines:devices") {
          void navigate({ to: "/settings/connections" });
        } else if (action === "mines:accounts") {
          void navigate({ to: "/settings/providers" });
        } else if (action.startsWith("mines:thread:")) {
          const [environment, thread] = action.slice("mines:thread:".length).split("/");
          if (!environment || !thread) return;
          void navigate({
            to: "/$environmentId/$threadId",
            params: {
              environmentId: EnvironmentId.make(decodeURIComponent(environment)),
              threadId: ThreadId.make(decodeURIComponent(thread)),
            },
          });
        }
      }),
    [navigate],
  );

  return null;
}
