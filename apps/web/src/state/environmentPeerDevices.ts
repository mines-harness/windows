import { serverUpdateStateAtom } from "@t3tools/client-runtime/state/server";
import { minesAccountIdAtom } from "@t3tools/client-runtime/catalog";
import {
  AuthAccessReadScope,
  sessionGrantsScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { peerState } from "./peers";
import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";

interface PeerDevicesSnapshot {
  readonly accountId: string | null;
  readonly sessions: ReadonlyMap<EnvironmentId, AuthSessionState>;
  readonly devices: ReadonlyMap<EnvironmentId, PeerDevice>;
}

const snapshotAtom = Atom.make((get): PeerDevicesSnapshot => {
  const accountId = get(minesAccountIdAtom);
  const previous = Option.getOrNull(get.self<PeerDevicesSnapshot>());
  const cached = previous?.accountId === accountId ? previous : null;
  const sessions = new Map<EnvironmentId, AuthSessionState>();
  const devices = new Map<EnvironmentId, PeerDevice>();
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
    const session = Option.getOrNull(AsyncResult.value(sessionResult));
    // A self-update temporarily resets the RPC session, including on interrupted restarts.
    // Keep its known identity so the account directory cannot create a second device row.
    const preservingUpdateIdentity = get(serverUpdateStateAtom(environmentId)).status !== "idle";
    if (preservingUpdateIdentity && (session === null || sessionResult._tag === "Failure")) {
      const retainedSession = cached?.sessions.get(environmentId);
      const retained = cached?.devices.get(environmentId);
      if (retainedSession && retained) {
        sessions.set(environmentId, retainedSession);
        devices.set(environmentId, retained);
      }
      continue;
    }
    if (
      sessionResult._tag === "Failure" ||
      session === null ||
      !sessionGrantsScope(session, AuthAccessReadScope)
    )
      continue;
    sessions.set(environmentId, session);
    const retained =
      cached && (preservingUpdateIdentity || cached.sessions.get(environmentId) === session)
        ? cached.devices.get(environmentId)
        : null;
    if (presentation.connection.phase !== "connected") {
      if (retained) devices.set(environmentId, retained);
      continue;
    }
    const result = get(peerState({ environmentId, input: {} }));
    const device = Option.getOrNull(AsyncResult.value(result))?.device ?? retained;
    if (device) devices.set(environmentId, device);
  }
  return {
    accountId,
    sessions,
    devices:
      cached !== null &&
      cached.devices.size === devices.size &&
      [...devices].every(([id, device]) => cached.devices.get(id) === device)
        ? cached.devices
        : devices,
  };
}).pipe(Atom.withLabel("web-environment-peer-devices-snapshot"));

export const environmentPeerDevicesAtom = Atom.make((get) => get(snapshotAtom).devices).pipe(
  Atom.withLabel("web-environment-peer-devices"),
);
