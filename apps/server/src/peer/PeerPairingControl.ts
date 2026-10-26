import {
  DevicePairingError,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import {
  completeDevicePairing,
  denyDevicePairing,
  listDevicePairings,
  reviewDevicePairing,
  type DevicePairingContext,
} from "@t3tools/shared/minesDevicePairing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class PeerPairingControl extends Context.Service<
  PeerPairingControl,
  {
    readonly pending: (
      input: DevicePairingContext,
    ) => Effect.Effect<ReadonlyArray<DevicePairingRequest>, DevicePairingError>;
    readonly review: (
      input: DevicePairingContext & { readonly code: string },
    ) => Effect.Effect<DevicePairingRequest, DevicePairingError>;
    readonly complete: (
      input: DevicePairingContext & {
        readonly request: DevicePairingRequest;
        readonly pairingUrl: string;
      },
    ) => Effect.Effect<void, DevicePairingError>;
    readonly deny: (
      input: DevicePairingContext & { readonly code: string },
    ) => Effect.Effect<void, DevicePairingError>;
  }
>()("mines/peer/PeerPairingControl") {}

const isDevicePairingError = Schema.is(DevicePairingError);
const unavailable = (cause: unknown) =>
  isDevicePairingError(cause) ? cause : new DevicePairingError({ code: "unavailable" });

export const layer = Layer.succeed(PeerPairingControl, {
  pending: Effect.fn("PeerPairingControl.pending")((input) =>
    Effect.tryPromise({
      try: (signal) => listDevicePairings({ ...input, signal }),
      catch: unavailable,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(unavailable(null)),
      }),
    ),
  ),
  review: Effect.fn("PeerPairingControl.review")((input) =>
    Effect.tryPromise({
      try: (signal) => reviewDevicePairing({ ...input, signal }),
      catch: unavailable,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(unavailable(null)),
      }),
    ),
  ),
  complete: Effect.fn("PeerPairingControl.complete")((input) =>
    Effect.tryPromise({
      try: (signal) => completeDevicePairing({ ...input, signal }),
      catch: unavailable,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(unavailable(null)),
      }),
    ),
  ),
  deny: Effect.fn("PeerPairingControl.deny")((input) =>
    Effect.tryPromise({
      try: (signal) => denyDevicePairing({ ...input, signal }),
      catch: unavailable,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(unavailable(null)),
      }),
    ),
  ),
});
