import {
  PeerManagementError,
  type PeerState,
  type PeerApproveInput,
  type PeerRevokeInput,
  type PeerStatus,
  type PeerDeviceStatus,
  type PeerCheckDeviceInput,
} from "@t3tools/contracts";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PeerTrustStore from "./PeerTrustStore.ts";
import * as PeerHost from "./PeerHost.ts";
import * as HostSignalingService from "./HostSignalingService.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
export class PeerManagement extends Context.Service<
  PeerManagement,
  {
    readonly state: Effect.Effect<typeof PeerState.Type, PeerManagementError>;
    readonly status: Effect.Effect<PeerStatus, PeerManagementError>;
    readonly checkDevice: (
      input: typeof PeerCheckDeviceInput.Type,
    ) => Effect.Effect<PeerDeviceStatus, PeerManagementError>;
    readonly approve: (
      input: typeof PeerApproveInput.Type,
    ) => Effect.Effect<typeof PeerState.Type, PeerManagementError>;
    readonly revoke: (
      input: typeof PeerRevokeInput.Type,
    ) => Effect.Effect<typeof PeerState.Type, PeerManagementError>;
  }
>()("mines/peer/PeerManagement") {}
const make = Effect.gen(function* () {
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const host = yield* PeerHost.PeerHost;
  const signaling = yield* HostSignalingService.HostSignalingService;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const connected = new Set<PeerSession>();
  const checked = new Map<string, { result: PeerDeviceStatus; at: number; publicKey: string }>();
  let statusIdentity: string | undefined;
  const unsubscribe = signaling.subscribeSessions((session) => {
    connected.add(session);
    void session.closed.then(() => {
      connected.delete(session);
      checked.delete(session.remoteDeviceId);
    });
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  const state = Effect.gen(function* () {
    return { device: (yield* trust.identity).device, approvedDevices: yield* trust.list };
  }).pipe(
    Effect.mapError(
      () => new PeerManagementError({ message: "The device trust store could not be read." }),
    ),
  );
  const readState = Effect.fn("PeerManagement.readStatusIdentity")(function* () {
    const current = yield* state;
    if (statusIdentity !== current.device.deviceId) {
      checked.clear();
      statusIdentity = current.device.deviceId;
    }
    return current;
  });
  const isConnected = (deviceId: string) =>
    [...connected].some((session) => session.remoteDeviceId === deviceId);
  return PeerManagement.of({
    state,
    status: Effect.gen(function* () {
      const current = yield* readState();
      const now = yield* Clock.currentTimeMillis;
      return {
        device: current.device,
        devices: current.approvedDevices.map((device) => {
          const previous = checked.get(device.deviceId);
          if (isConnected(device.deviceId))
            return { device, status: "connected" as const, checkedAt: null, failure: null };
          if (previous && previous.publicKey === device.publicKey && now - previous.at <= 60_000) {
            const { deviceId: _, ...result } = previous.result;
            return { device, ...result };
          }
          return {
            device,
            status: "not-tested" as const,
            checkedAt: previous?.result.checkedAt ?? null,
            failure: null,
          };
        }),
      };
    }),
    checkDevice: Effect.fn("PeerManagement.checkDevice")(function* (input) {
      const current = yield* readState();
      const device = current.approvedDevices.find((device) => device.deviceId === input.deviceId);
      const now = yield* Clock.currentTimeMillis;
      const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
      if (!device)
        return {
          deviceId: input.deviceId,
          status: "approval-required",
          checkedAt,
          failure: "unapproved-device",
        };
      if (isConnected(input.deviceId))
        return { deviceId: input.deviceId, status: "connected", checkedAt, failure: null };
      const result: PeerDeviceStatus = yield* Effect.scoped(
        signaling.connect(input.deviceId, { publishSession: false }),
      ).pipe(
        Effect.as({
          deviceId: input.deviceId,
          status: "reachable" as const,
          checkedAt,
          failure: null,
        }),
        Effect.catchTags({
          PeerError: (error) =>
            Effect.succeed({
              deviceId: input.deviceId,
              status:
                error.code === "unapproved-device"
                  ? ("approval-required" as const)
                  : ("unavailable" as const),
              checkedAt,
              failure: error.code,
            }),
        }),
      );
      const latest = yield* state;
      if (
        latest.device.deviceId !== current.device.deviceId ||
        !latest.approvedDevices.some(
          (entry) => entry.deviceId === device.deviceId && entry.publicKey === device.publicKey,
        )
      )
        return {
          deviceId: input.deviceId,
          status: "approval-required",
          checkedAt,
          failure: "unapproved-device",
        };
      const finishedAt = yield* Clock.currentTimeMillis;
      const completed = {
        ...result,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(finishedAt)),
      };
      checked.set(device.deviceId, {
        result: completed,
        at: finishedAt,
        publicKey: device.publicKey,
      });
      return completed;
    }),
    approve: Effect.fn("PeerManagement.approve")(function* (input) {
      yield* trust
        .approve(input.device)
        .pipe(
          Effect.mapError(
            () => new PeerManagementError({ message: "The device approval could not be saved." }),
          ),
        );
      return yield* state;
    }),
    revoke: Effect.fn("PeerManagement.revoke")(function* (input) {
      checked.delete(input.deviceId);
      yield* trust
        .revoke(input.deviceId)
        .pipe(
          Effect.mapError(
            () => new PeerManagementError({ message: "The device revocation could not be saved." }),
          ),
        );
      yield* host.disconnectDevice(input.deviceId);
      yield* signaling.disconnectDevice(input.deviceId);
      yield* auth.revokeDevicePairingAccess(input.deviceId).pipe(
        Effect.mapError(
          () =>
            new PeerManagementError({
              message: "The device's access tokens could not be revoked.",
            }),
        ),
      );
      return yield* state;
    }),
  });
});
export const layer = Layer.effect(PeerManagement, make);
