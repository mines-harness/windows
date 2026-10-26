import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionOnboarding,
  EnvironmentRegistry,
} from "@t3tools/client-runtime/connection";
import {
  connectDirectPeer,
  openPeerSignalGateway,
  peerFetch,
  PeerConnections,
  registerPeerDevice,
  type PeerSession,
} from "@t3tools/client-runtime/peer";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import { PeerDevice, PeerError } from "@t3tools/contracts/minesPeer";
import { decodePeerPairing, encodePeerApproval } from "@t3tools/shared/minesPeerPairing";
import { createPeerIdentity, type PeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Base64Url from "effect/encoding/Base64Url";
import { openBrowserPrivateStore } from "../catalog/storage";
import { clientPresentationMetadata } from "./clientMetadata";

const Identity = Schema.Struct({ privateKey: Schema.String, label: Schema.String });
const Route = Schema.Struct({
  host: PeerDevice,
  controlUrl: Schema.String,
  stunServers: Schema.Array(Schema.String),
  environmentId: EnvironmentId,
  setupId: Schema.optionalKey(Schema.String),
});
type Route = typeof Route.Type;
const decodeIdentity = Schema.decodeUnknownSync(Schema.fromJsonString(Identity));
const decodeRoutes = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Route)));
const isPeerError = Schema.is(PeerError);
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Identity));
const encodeRoutes = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Route)));
const text = new TextEncoder();
const decode = new TextDecoder();
export class PeerClientSetupError extends Schema.TaggedError<PeerClientSetupError>()(
  "PeerClientSetupError",
  { message: Schema.String },
) {}
const failure = (cause: unknown) =>
  new PeerClientSetupError({
    message: cause instanceof Error ? cause.message : "Direct device setup failed.",
  });
const nowSeconds = () => Math.floor(Date.now() / 1000);
// @effect-diagnostics-next-line cryptoRandomUUID:off -- The native signaling callback synchronously requests a nonce.
const randomId = () => crypto.randomUUID();

async function locked<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  if (!accountId || accountId.length > 256) throw new Error("Sign in to mines first.");
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely store device keys. Use the mines desktop app or a browser with Web Locks.",
    );
  return navigator.locks.request(`mines-peer:${accountId}`, operation);
}
function browserPeerDeviceMetadata(): { label: string; platform?: PeerDevice["platform"] } {
  const metadata = clientPresentationMetadata({
    appVersion: "0.0.0",
    hosted: false,
    identity: {
      userAgent: navigator.userAgent ?? "",
      platform: navigator.platform ?? "",
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    },
    desktopBridge: window.desktopBridge,
  });
  switch (metadata.os) {
    case "macOS":
      return { platform: "macos", label: "Mac" };
    case "Windows":
      return { platform: "windows", label: "Windows PC" };
    case "Linux":
      return { platform: "linux", label: "Linux computer" };
    case "iOS":
      return { platform: "ios", label: metadata.deviceType === "tablet" ? "iPad" : "iPhone" };
    case "Android":
      return {
        platform: "android",
        label: metadata.deviceType === "tablet" ? "Android tablet" : "Android phone",
      };
    default:
      return { label: window.desktopBridge ? "Desktop" : "Browser" };
  }
}
export const loadBrowserPeerIdentity = Effect.fn("web.peer.identity")(function* (
  accountId: string,
  label?: string,
) {
  return yield* Effect.tryPromise({
    try: () =>
      locked(accountId, async () => {
        const metadata = browserPeerDeviceMetadata();
        const store = await openBrowserPrivateStore(accountId);
        const saved = await store.read("peer.identity.v1");
        const record = saved
          ? decodeIdentity(decode.decode(saved))
          : {
              privateKey: Base64Url.encode(crypto.getRandomValues(new Uint8Array(32))),
              label: metadata.label,
            };
        const nextLabel =
          label?.trim().slice(0, 80) ||
          (record.label === "mines desktop client" || record.label === "mines browser client"
            ? metadata.label
            : record.label);
        const identity = createPeerIdentity(
          Result.getOrThrow(Base64Url.decode(record.privateKey)),
          nextLabel,
          metadata.platform,
        );
        if (!saved || nextLabel !== record.label)
          await store.write(
            "peer.identity.v1",
            text.encode(encodeIdentity({ ...record, label: nextLabel })),
          );
        return identity;
      }),
    catch: failure,
  });
});
export const listBrowserPeerRoutes = Effect.fn("web.peer.routes")(function* (accountId: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const store = await openBrowserPrivateStore(accountId);
      const saved = await store.read("peer.routes.v1");
      return saved ? decodeRoutes(decode.decode(saved)) : [];
    },
    catch: failure,
  });
});
function updateRoutes(accountId: string, update: (routes: readonly Route[]) => readonly Route[]) {
  return Effect.tryPromise({
    try: () =>
      locked(accountId, async () => {
        const store = await openBrowserPrivateStore(accountId);
        const saved = await store.read("peer.routes.v1");
        const routes = update(saved ? decodeRoutes(decode.decode(saved)) : []);
        await store.write("peer.routes.v1", text.encode(encodeRoutes(routes)));
      }),
    catch: failure,
  });
}
function connectRoute(
  identity: PeerIdentity,
  route: Route,
  abort?: AbortSignal,
): Effect.Effect<PeerSession, PeerError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const directSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(30_000),
        ...(abort ? [abort] : []),
      ]);
      const gateway = await openPeerSignalGateway({
        controlUrl: route.controlUrl,
        identity,
        randomId,
        nowSeconds,
        signal: directSignal,
      });
      try {
        return await connectDirectPeer({
          identity,
          approved: route.host,
          gateway,
          sessionId: randomId(),
          nowSeconds,
          stunServers: route.stunServers,
          signal: directSignal,
        });
      } finally {
        gateway.close();
      }
    },
    catch: (cause) => (isPeerError(cause) ? cause : new PeerError({ code: "direct-unavailable" })),
  });
}
export const restoreBrowserPeers = Effect.fn("web.peer.restore")(function* (
  accountId: string | null,
) {
  const peers = yield* PeerConnections;
  yield* peers.clear;
  if (accountId === null) return [];
  const routes = yield* listBrowserPeerRoutes(accountId);
  if (routes.length === 0) return [];
  const identity = yield* loadBrowserPeerIdentity(accountId);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  for (const route of routes) {
    yield* peers.register(route.host.deviceId, connectRoute(identity, route));
    yield* registry.retryNow(route.environmentId);
  }
  return routes.map((route) => route.environmentId);
});
export const browserPeerApproval = Effect.fn("web.peer.approval")(function* (accountId: string) {
  const identity = yield* loadBrowserPeerIdentity(accountId);
  return { device: identity.device, code: encodePeerApproval(identity.device) };
});
export const pairBrowserPeer = Effect.fn("web.peer.pair")(function* (input: {
  readonly accountId: string;
  readonly pairingUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly isCurrent?: () => boolean;
  readonly signal?: AbortSignal;
}) {
  const current = () => !input.signal?.aborted && (input.isCurrent?.() ?? true);
  const checkAccount = () =>
    current()
      ? Effect.void
      : Effect.fail(
          new PeerClientSetupError({
            message: "Your Mines account changed. Start this connection again.",
          }),
        );
  yield* checkAccount();
  const payload = yield* Effect.try({
    try: () => decodePeerPairing(input.pairingUrl, nowSeconds()),
    catch: failure,
  });
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const guarded = input.isCurrent !== undefined || input.signal !== undefined;
  const existing = (yield* SubscriptionRef.get(registry.entries)).get(payload.environmentId);
  if (existing?.target._tag === "PrimaryConnectionTarget")
    return yield* new PeerClientSetupError({
      message:
        "This computer is already your local workspace. Paste a different computer's pairing link.",
    });
  if (guarded && existing !== undefined)
    return yield* new PeerClientSetupError({
      message: "This computer is already added. Open it or retry its existing connection.",
    });
  const identity = yield* loadBrowserPeerIdentity(input.accountId);
  const accountId = yield* Effect.tryPromise({
    try: () =>
      registerPeerDevice({
        controlUrl: payload.controlUrl,
        identity,
        randomId,
        nowSeconds,
        bearerToken: async () => {
          if (!current()) throw new Error("Your Mines account changed.");
          const token = await input.getToken();
          if (!current()) throw new Error("Your Mines account changed.");
          if (!token) throw new PeerClientSetupError({ message: "Sign in to mines first." });
          return token;
        },
      }),
    catch: failure,
  });
  if (accountId !== input.accountId) return yield* new PeerError({ code: "unapproved-device" });
  yield* checkAccount();
  const route: Route = {
    host: payload.host,
    controlUrl: payload.controlUrl,
    stunServers: payload.stunServers,
    environmentId: payload.environmentId,
    ...(guarded ? { setupId: randomId() } : {}),
  };
  const session = yield* connectRoute(identity, route, input.signal);
  if (!current()) {
    session.close();
    return yield* new PeerClientSetupError({
      message: "Your Mines account changed. Start this connection again.",
    });
  }
  const close = () => session.close();
  input.signal?.addEventListener("abort", close, { once: true });
  const registration = yield* ConnectionOnboarding.preparePairingRegistration({
    host: "http://127.0.0.1",
    pairingCode: payload.pairingToken,
    expectedEnvironmentId: payload.environmentId,
  }).pipe(
    Effect.provide(layerRemoteHttpClient(peerFetch(session, "http://127.0.0.1"))),
    Effect.ensuring(
      Effect.sync(() => {
        input.signal?.removeEventListener("abort", close);
        session.close();
      }),
    ),
  );
  yield* checkAccount();
  const connectionId = `peer:${route.host.deviceId}:${route.environmentId}${route.setupId ? `:${route.setupId}` : ""}`;
  const next = new BearerConnectionRegistration({
    ...registration,
    target: new BearerConnectionTarget({ ...registration.target, connectionId }),
    profile: new BearerConnectionProfile({
      ...registration.profile,
      connectionId,
      peerDeviceId: route.host.deviceId,
    }),
  });
  const peers = yield* PeerConnections;
  let previousRoute: Route | undefined;
  let routeWritten = false;
  let registrationAttempted = false;
  let unregister: (() => void) | undefined;
  const rollback = Effect.gen(function* () {
    unregister?.();
    if (guarded && registrationAttempted)
      yield* registry.removeRoute(route.environmentId, connectionId).pipe(Effect.ignore);
    if (routeWritten)
      yield* updateRoutes(input.accountId, (routes) => {
        const installed = routes.find((entry) => entry.environmentId === route.environmentId);
        if (installed?.setupId !== route.setupId) return routes;
        return [
          ...routes.filter((entry) => entry.environmentId !== route.environmentId),
          ...(previousRoute ? [previousRoute] : []),
        ];
      }).pipe(Effect.ignore);
    if (input.isCurrent?.() ?? true)
      yield* restoreBrowserPeers(input.accountId).pipe(Effect.ignore);
  });
  return yield* Effect.gen(function* () {
    routeWritten = true;
    yield* updateRoutes(input.accountId, (routes) => {
      if (!current()) throw new Error("Your Mines account changed.");
      previousRoute = routes.find((entry) => entry.environmentId === route.environmentId);
      return [...routes.filter((entry) => entry.environmentId !== route.environmentId), route];
    });
    yield* checkAccount();
    if (guarded && (yield* SubscriptionRef.get(registry.entries)).has(route.environmentId))
      return yield* new PeerClientSetupError({
        message: "This computer was added elsewhere. Open its existing connection.",
      });
    unregister = yield* peers.register(route.host.deviceId, connectRoute(identity, route));
    yield* checkAccount();
    registrationAttempted = true;
    if (!(yield* registry.register(next)))
      return yield* new PeerClientSetupError({
        message: "The computer is managed by this app and cannot be replaced.",
      });
    yield* checkAccount();
    yield* registry.setEnabled(route.environmentId, true);
    yield* checkAccount();
    yield* registry.retryNow(route.environmentId);
    yield* checkAccount();
    return route.environmentId;
  }).pipe(
    Effect.uninterruptible,
    Effect.onError(() => rollback),
  );
});
export const forgetBrowserPeer = Effect.fn("web.peer.forget")(function* (input: {
  accountId: string;
  environmentId: EnvironmentId;
}) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* updateRoutes(input.accountId, (routes) =>
    routes.filter((entry) => entry.environmentId !== input.environmentId),
  );
  const allowed = yield* restoreBrowserPeers(input.accountId);
  yield* registry.remove(input.environmentId);
  return allowed;
});
