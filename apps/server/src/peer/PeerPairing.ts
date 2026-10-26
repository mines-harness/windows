import {
  DevicePairingApproveInput,
  DevicePairingCodeInput,
  DevicePairingError,
  type DevicePairingApproval,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import { encodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import type { DevicePairingContext } from "@t3tools/shared/minesDevicePairing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostSignalingService from "./HostSignalingService.ts";
import * as PeerHost from "./PeerHost.ts";
import * as PeerPairingControl from "./PeerPairingControl.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";
import { peerDeviceAccessSubject } from "./PeerDeviceAccess.ts";

export class PeerPairing extends Context.Service<
  PeerPairing,
  {
    readonly pending: Effect.Effect<ReadonlyArray<DevicePairingRequest>, DevicePairingError>;
    readonly approve: (
      input: typeof DevicePairingApproveInput.Type,
      permittedScopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Effect.Effect<DevicePairingApproval, DevicePairingError>;
    readonly deny: (
      input: typeof DevicePairingCodeInput.Type,
    ) => Effect.Effect<void, DevicePairingError>;
  }
>()("mines/peer/PeerPairing") {}

const forbidden = () => new DevicePairingError({ code: "forbidden" });
const unavailable = () => new DevicePairingError({ code: "unavailable" });
const invalid = () => new DevicePairingError({ code: "invalid-input" });
const decodeApprove = Schema.decodeUnknownEffect(DevicePairingApproveInput);
const decodeCode = Schema.decodeUnknownEffect(DevicePairingCodeInput);

const make = Effect.gen(function* () {
  const trust = yield* PeerTrustStore.PeerTrustStore;
  const signaling = yield* HostSignalingService.HostSignalingService;
  const peerHost = yield* PeerHost.PeerHost;
  const control = yield* PeerPairingControl.PeerPairingControl;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);

  const context = Effect.gen(function* () {
    const configured = yield* SubscriptionRef.get(signaling.state);
    if (!configured.configured || !configured.accountId || !configured.controlUrl)
      return yield* unavailable();
    const identity = yield* trust.identity.pipe(Effect.mapError(unavailable));
    const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    let sequence = 0;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const client: DevicePairingContext = {
      controlUrl: configured.controlUrl,
      identity,
      nowSeconds: () => now,
      randomId: () => `${nonce}-${++sequence}`,
    };
    return { configured, client, identity, accountId: configured.accountId };
  });
  type Current = Effect.Success<typeof context>;
  const assertCurrent = Effect.fn("PeerPairing.assertCurrent")(function* (before: Current) {
    const configured = yield* SubscriptionRef.get(signaling.state);
    const identity = yield* trust.identity.pipe(Effect.mapError(forbidden));
    if (
      !configured.configured ||
      configured.accountId !== before.accountId ||
      configured.controlUrl !== before.client.controlUrl ||
      identity.device.deviceId !== before.identity.device.deviceId ||
      identity.device.publicKey !== before.identity.device.publicKey
    )
      return yield* forbidden();
  });
  const verifyTarget = Effect.fn("PeerPairing.verifyTarget")(function* (
    current: Current,
    request: DevicePairingRequest,
  ) {
    yield* assertCurrent(current);
    if (
      request.target.deviceId !== current.identity.device.deviceId ||
      request.target.publicKey !== current.identity.device.publicKey
    )
      return yield* forbidden();
    const expiresAt = Date.parse(request.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* new DevicePairingError({ code: "expired" });
  });
  const assertApproved = Effect.fn("PeerPairing.assertApproved")(function* (
    current: Current,
    request: DevicePairingRequest,
  ) {
    yield* verifyTarget(current, request);
    if (
      !(yield* trust.list.pipe(Effect.mapError(unavailable))).some(
        (device) =>
          device.deviceId === request.requester.deviceId &&
          device.publicKey === request.requester.publicKey,
      )
    )
      return yield* forbidden();
  });
  return PeerPairing.of({
    pending: Effect.gen(function* () {
      const current = yield* context;
      yield* assertCurrent(current);
      const requests = yield* control.pending(current.client);
      for (const request of requests) yield* verifyTarget(current, request);
      return requests;
    }),
    approve: Effect.fn("PeerPairing.approve")(function* (value, permittedScopes) {
      const input = yield* decodeApprove(value).pipe(Effect.mapError(invalid));
      if (
        input.scopes.length === 0 ||
        new Set(input.scopes).size !== input.scopes.length ||
        input.scopes.some((scope) => !permittedScopes.includes(scope))
      )
        return yield* forbidden();
      const current = yield* context;
      yield* assertCurrent(current);
      const request = yield* control.review({ ...current.client, code: input.code });
      yield* verifyTarget(current, request);
      const owner = { accountId: current.accountId, deviceId: current.identity.device.deviceId };
      const remaining = Date.parse(request.expiresAt) - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return yield* new DevicePairingError({ code: "expired" });
      let committed = false;
      return yield* Effect.acquireUseRelease(
        trust.beginApproval(request.requester, owner).pipe(Effect.mapError(forbidden)),
        () =>
          Effect.acquireUseRelease(
            auth
              .createPairingLink({
                label: request.requester.label,
                subject: peerDeviceAccessSubject(request.requester.deviceId, request.id),
                scopes: input.scopes,
                ttl: Duration.millis(Math.min(remaining, 5 * 60_000)),
              })
              .pipe(Effect.mapError(unavailable)),
            (grant) =>
              Effect.gen(function* () {
                yield* assertApproved(current, request);
                const environmentId = yield* environment.getEnvironmentId;
                const pairingUrl = yield* Effect.try({
                  try: () =>
                    encodePeerPairing({
                      version: 1,
                      host: current.identity.device,
                      controlUrl: current.client.controlUrl,
                      stunServers: current.configured.stunServers,
                      environmentId,
                      pairingToken: grant.credential,
                      expiresAt: DateTime.formatIso(grant.expiresAt),
                    }),
                  catch: unavailable,
                });
                yield* control.complete({ ...current.client, request, pairingUrl });
                yield* assertApproved(current, request);
                committed = true;
                return { code: request.code, requester: request.requester };
              }),
            () =>
              committed
                ? Effect.void
                : auth
                    .revokeDevicePairingAccess(request.requester.deviceId, request.id)
                    .pipe(Effect.ignore),
          ),
        (approval) =>
          committed
            ? Effect.void
            : Effect.gen(function* () {
                const removed = yield* approval.rollback.pipe(Effect.orElseSucceed(() => false));
                if (removed) {
                  yield* peerHost.disconnectDevice(request.requester.deviceId);
                  yield* signaling.disconnectDevice(request.requester.deviceId);
                }
              }),
      );
    }, lock.withPermit),
    deny: Effect.fn("PeerPairing.deny")(function* (value) {
      const input = yield* decodeCode(value).pipe(Effect.mapError(invalid));
      const current = yield* context;
      yield* assertCurrent(current);
      yield* control.deny({ ...current.client, code: input.code });
      yield* assertCurrent(current);
    }, lock.withPermit),
  });
});

export const layer = Layer.effect(PeerPairing, make);
