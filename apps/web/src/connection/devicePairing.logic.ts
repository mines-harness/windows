import type { EnvironmentId } from "@t3tools/contracts";
import {
  DevicePairingError,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import type { PeerIdentity } from "@t3tools/shared/minesPeerTrust";
import type {
  DevicePairingContext,
  DevicePairingSession,
} from "@t3tools/shared/minesDevicePairing";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type PeerPairingRequest = Pick<
  DevicePairingRequest,
  "id" | "code" | "expiresAt" | "requester" | "target"
>;
export type PeerPairingProgress =
  | { readonly status: "pending" | "denied" | "cancelled" | "expired" }
  | { readonly status: "connected"; readonly environmentId: EnvironmentId };

export class DevicePairingSetupError extends Schema.TaggedError<DevicePairingSetupError>()(
  "DevicePairingSetupError",
  { message: Schema.String },
) {}

export interface BeginPeerPairingInput {
  readonly accountId: string;
  readonly targetDeviceId: string;
  readonly controlUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly label?: string;
}
export interface CollectPeerPairingInput {
  readonly accountId: string;
  readonly requestId: string;
  readonly getToken: () => Promise<string | null>;
}
export interface CancelPeerPairingInput {
  readonly accountId: string;
  readonly requestId: string;
}

interface Pending {
  readonly accountId: string;
  readonly context: DevicePairingContext;
  readonly session: DevicePairingSession;
  readonly controller: AbortController;
  cancelled: boolean;
}
const fail = (message: string) => new DevicePairingSetupError({ message });
const isDevicePairingError = Schema.is(DevicePairingError);
const isDevicePairingSetupError = Schema.is(DevicePairingSetupError);
const requestGone = (cause: unknown) =>
  isDevicePairingError(cause) && (cause.code === "expired" || cause.code === "not-found");
const requestFailure = (cause: unknown, fallback: string) =>
  isDevicePairingSetupError(cause)
    ? cause
    : fail(isDevicePairingError(cause) ? cause.message : fallback);
const accountChanged = () => fail("Your Mines account changed. Start this connection again.");
const publicRequest = (request: DevicePairingRequest): PeerPairingRequest => ({
  id: request.id,
  code: request.code,
  expiresAt: request.expiresAt,
  requester: request.requester,
  target: request.target,
});

export function makeDevicePairingAdapter<R, E>(dependencies: {
  readonly identity: (accountId: string, label?: string) => Effect.Effect<PeerIdentity, Error>;
  readonly begin: (
    input: DevicePairingContext & {
      readonly targetDeviceId: string;
      readonly bearerToken: () => Promise<string>;
    },
  ) => Promise<DevicePairingSession>;
  readonly collect: (
    input: DevicePairingContext & { readonly pairing: DevicePairingSession },
  ) => Promise<
    | { readonly status: "pending" | "denied" | "cancelled" | "expired" }
    | { readonly status: "approved"; readonly pairingUrl: string }
  >;
  readonly cancel: (
    input: DevicePairingContext & { readonly pairing: DevicePairingSession },
  ) => Promise<void>;
  readonly pair: (input: {
    readonly accountId: string;
    readonly pairingUrl: string;
    readonly getToken: () => Promise<string | null>;
    readonly isCurrent: () => boolean;
    readonly signal?: AbortSignal;
  }) => Effect.Effect<EnvironmentId, E, R>;
  readonly nowSeconds: () => number;
  readonly randomId: () => string;
}) {
  const pending = new Map<string, Pending>();
  const starting = new Set<AbortController>();
  let selectedAccount: string | null = null;
  const drop = (id: string) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.controller.abort();
    entry.session.privateKey.fill(0);
  };
  const expired = (entry: Pending) =>
    Date.parse(entry.session.request.expiresAt) <= dependencies.nowSeconds() * 1000;
  const prune = () => {
    for (const [id, entry] of pending) if (expired(entry)) drop(id);
  };
  const selectAccount = Effect.fn("web.peer.pairingAccount")(function* (accountId: string | null) {
    if (selectedAccount === accountId) return;
    selectedAccount = accountId;
    for (const controller of starting) controller.abort();
    starting.clear();
    const previous = [...pending.values()];
    for (const [id, entry] of pending) {
      entry.cancelled = true;
      drop(id);
    }
    yield* Effect.forEach(
      previous,
      (entry) =>
        Effect.tryPromise((signal) =>
          dependencies.cancel({ ...entry.context, signal, pairing: entry.session }),
        ).pipe(Effect.timeout("3 seconds"), Effect.ignore),
      { concurrency: 4, discard: true },
    );
  });
  const begin = Effect.fn("web.peer.beginPairing")(function* (
    input: BeginPeerPairingInput,
    isCurrent: () => boolean,
  ) {
    if (!isCurrent() || selectedAccount !== input.accountId) return yield* accountChanged();
    prune();
    if (pending.size + starting.size >= 4)
      return yield* fail("Finish or cancel a device connection before adding another.");
    const identity = yield* dependencies
      .identity(input.accountId, input.label)
      .pipe(
        Effect.mapError(() =>
          fail("This device’s key could not be opened. Unlock it and try again."),
        ),
      );
    if (!isCurrent() || selectedAccount !== input.accountId) return yield* accountChanged();
    // @effect-diagnostics-next-line abortControllerInEffect:off -- One request spans approval polling and the final direct connection.
    const controller = new AbortController();
    starting.add(controller);
    const context = {
      controlUrl: input.controlUrl,
      identity,
      nowSeconds: dependencies.nowSeconds,
      randomId: dependencies.randomId,
      signal: controller.signal,
    };
    const session = yield* Effect.tryPromise({
      try: (signal) =>
        dependencies.begin({
          ...context,
          signal: AbortSignal.any([controller.signal, signal]),
          targetDeviceId: input.targetDeviceId,
          bearerToken: async () => {
            if (!isCurrent() || selectedAccount !== input.accountId) throw accountChanged();
            const token = await input.getToken();
            if (!isCurrent() || selectedAccount !== input.accountId) throw accountChanged();
            if (!token) throw fail("Sign in to Mines before connecting a device.");
            return token;
          },
        }),
      catch: (cause) =>
        requestFailure(cause, "The connection request could not be sent. Try again."),
    }).pipe(Effect.ensuring(Effect.sync(() => starting.delete(controller))));
    if (!isCurrent() || selectedAccount !== input.accountId) {
      controller.abort();
      session.privateKey.fill(0);
      return yield* accountChanged();
    }
    const expiry = Date.parse(session.request.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= dependencies.nowSeconds() * 1000) {
      controller.abort();
      session.privateKey.fill(0);
      return yield* fail("This connection request expired. Start a new connection.");
    }
    pending.set(session.request.id, {
      accountId: input.accountId,
      context,
      session,
      controller,
      cancelled: false,
    });
    return publicRequest(session.request);
  });
  const collect = Effect.fn("web.peer.collectPairing")(function* (
    input: CollectPeerPairingInput,
    isCurrent: () => boolean,
  ) {
    if (!isCurrent() || selectedAccount !== input.accountId) return yield* accountChanged();
    const entry = pending.get(input.requestId);
    if (!entry || entry.accountId !== input.accountId) return { status: "expired" } as const;
    if (expired(entry)) {
      drop(input.requestId);
      return { status: "expired" } as const;
    }
    const collected = yield* Effect.tryPromise({
      try: async (signal) => {
        try {
          return await dependencies.collect({
            ...entry.context,
            signal: AbortSignal.any([entry.controller.signal, signal]),
            pairing: entry.session,
          });
        } catch (cause) {
          if (requestGone(cause)) return { status: "expired" } as const;
          throw cause;
        }
      },
      catch: (cause) => requestFailure(cause, "The approval could not be checked. Try again."),
    }).pipe(Effect.result);
    if (entry.cancelled) return { status: "cancelled" } as const;
    if (!isCurrent() || selectedAccount !== input.accountId) {
      drop(input.requestId);
      return yield* accountChanged();
    }
    if (Result.isFailure(collected)) return yield* collected.failure;
    const response = collected.success;
    if (response.status === "pending") return response;
    if (response.status !== "approved") {
      drop(input.requestId);
      return response;
    }
    entry.session.privateKey.fill(0);
    const paired = yield* dependencies
      .pair({
        accountId: input.accountId,
        pairingUrl: response.pairingUrl,
        getToken: input.getToken,
        isCurrent,
        signal: entry.controller.signal,
      })
      .pipe(Effect.result, Effect.ensuring(Effect.sync(() => drop(input.requestId))));
    if (entry.cancelled) return { status: "cancelled" } as const;
    if (!isCurrent() || selectedAccount !== input.accountId) return yield* accountChanged();
    if (Result.isFailure(paired)) return yield* Effect.fail(paired.failure);
    return { status: "connected", environmentId: paired.success } as const;
  });
  const cancel = Effect.fn("web.peer.cancelPairing")(function* (input: CancelPeerPairingInput) {
    const entry = pending.get(input.requestId);
    if (!entry || entry.accountId !== input.accountId) return;
    pending.delete(input.requestId);
    entry.cancelled = true;
    entry.controller.abort();
    yield* Effect.tryPromise({
      try: async (signal) => {
        try {
          await dependencies.cancel({ ...entry.context, signal, pairing: entry.session });
        } catch (cause) {
          if (!requestGone(cause)) throw cause;
        }
      },
      catch: (cause) =>
        requestFailure(
          cause,
          "This connection stopped here, but its remote request could not be cancelled.",
        ),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          entry.controller.abort();
          entry.session.privateKey.fill(0);
        }),
      ),
    );
  });
  return { selectAccount, begin, collect, cancel };
}
