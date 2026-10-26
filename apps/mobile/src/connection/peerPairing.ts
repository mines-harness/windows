import {
  ConnectionOnboarding,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  EnvironmentRegistry,
} from "@t3tools/client-runtime/connection";
import {
  connectDirectPeer,
  openPeerSignalGateway,
  registerPeerDevice,
  peerFetch,
  PeerConnections,
  type PeerSession,
} from "@t3tools/client-runtime/peer";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { PeerDevice, PeerError } from "@t3tools/contracts/minesPeer";
import { EnvironmentId } from "@t3tools/contracts";
import { createPeerIdentity, type PeerIdentity } from "@t3tools/shared/minesPeerTrust";
import { decodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import { createMobilePeer } from "../lib/minesPeer";

const LEGACY_IDENTITY_KEY = "mines.peer.identity.v1";
const ROUTES_KEY = "mines.peer.routes.v1";
const IdentityRecord = Schema.Struct({ privateKey: Schema.String, label: Schema.String });
const SavedPeerRoute = Schema.Struct({
  accountId: Schema.String,
  host: PeerDevice,
  controlUrl: Schema.String,
  stunServers: Schema.Array(Schema.String),
  environmentId: EnvironmentId,
});
type SavedPeerRoute = typeof SavedPeerRoute.Type;
const decodeIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(IdentityRecord));
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(IdentityRecord));
const decodeRoutes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(SavedPeerRoute)),
);
const encodeRoutes = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SavedPeerRoute)));
const nowSeconds = () => Math.floor(Date.now() / 1000);

export const loadPeerIdentity = Effect.fn("mobile.peer.loadIdentity")(function* (
  accountId: string,
) {
  if (!accountId || accountId.length > 256)
    return yield* new PeerError({ code: "unapproved-device" });
  const storage = yield* MobileSecureStorage;
  const key = `mines.peer.identity.v2.${Base64Url.encode(new TextEncoder().encode(accountId))}`;
  let saved = yield* storage.getItem(key);
  if (saved === null) {
    // A legacy key may be reused only for the account proven by its saved routes.
    const owners = new Set((yield* readRoutes()).map((route) => route.accountId));
    if (owners.size === 1 && owners.has(accountId))
      saved = yield* storage.getItem(LEGACY_IDENTITY_KEY);
  }
  const record =
    saved === null
      ? {
          privateKey: Base64Url.encode(Crypto.getRandomBytes(32)),
          label: (Device.deviceName?.trim() || Device.modelName?.trim() || "My phone").slice(0, 80),
        }
      : yield* decodeIdentity(saved);
  const currentLabel = (Device.deviceName?.trim() || Device.modelName?.trim() || "My phone").slice(
    0,
    80,
  );
  const label = record.label === "My phone" ? currentLabel : record.label;
  const platform =
    Device.osName === "iOS" ? "ios" : Device.osName === "Android" ? "android" : undefined;
  const identity = yield* Effect.try({
    try: () =>
      createPeerIdentity(Result.getOrThrow(Base64Url.decode(record.privateKey)), label, platform),
    catch: () => new PeerError({ code: "invalid-signature" }),
  });
  yield* storage.setItem(key, yield* encodeIdentity({ ...record, label }));
  return identity;
});

const readRoutes = Effect.fn("mobile.peer.readRoutes")(function* () {
  const storage = yield* MobileSecureStorage;
  const value = yield* storage.getItem(ROUTES_KEY);
  return value === null ? [] : yield* decodeRoutes(value);
});

function connectRoute(
  identity: PeerIdentity,
  route: SavedPeerRoute,
): Effect.Effect<PeerSession, PeerError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, 30000);
      try {
        const gateway = await openPeerSignalGateway({
          controlUrl: route.controlUrl,
          identity,
          randomId: Crypto.randomUUID,
          nowSeconds,
          signal: abort.signal,
        });
        try {
          return await connectDirectPeer({
            identity,
            approved: route.host,
            gateway,
            sessionId: Crypto.randomUUID(),
            nowSeconds,
            stunServers: route.stunServers,
            signal: abort.signal,
            createEndpoint: createMobilePeer,
          });
        } finally {
          gateway.close();
        }
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", cancel);
      }
    },
    catch: (cause) =>
      cause instanceof PeerError ? cause : new PeerError({ code: "direct-unavailable" }),
  });
}

export const restorePhonePeers = Effect.fn("mobile.peer.restorePhonePeers")(function* (
  accountId: string | null,
) {
  const peers = yield* PeerConnections;
  yield* peers.clear;
  if (accountId === null) return [];
  const identity = yield* loadPeerIdentity(accountId);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const environmentIds: EnvironmentId[] = [];
  for (const route of yield* readRoutes()) {
    if (route.accountId !== accountId) continue;
    yield* peers.register(route.host.deviceId, connectRoute(identity, route));
    yield* registry.retryNow(route.environmentId);
    environmentIds.push(route.environmentId);
  }
  return environmentIds;
});

export const pairPhone = Effect.fn("mobile.peer.pairPhone")(function* (input: {
  readonly pairingUrl: string;
  readonly accountId: string;
  readonly getToken: () => Promise<string | null>;
}) {
  const payload = yield* Effect.try({
    try: () => decodePeerPairing(input.pairingUrl, nowSeconds()),
    catch: (cause) => new Error(cause instanceof Error ? cause.message : "Invalid pairing code."),
  });
  const identity = yield* loadPeerIdentity(input.accountId);
  const peers = yield* PeerConnections;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const storage = yield* MobileSecureStorage;
  const route: SavedPeerRoute = {
    accountId: input.accountId,
    host: payload.host,
    controlUrl: payload.controlUrl,
    stunServers: payload.stunServers,
    environmentId: payload.environmentId,
  };
  const registeredAccountId = yield* Effect.tryPromise({
    try: () =>
      registerPeerDevice({
        controlUrl: payload.controlUrl,
        identity,
        randomId: Crypto.randomUUID,
        nowSeconds,
        bearerToken: async () => {
          const token = await input.getToken();
          if (!token) throw new PeerError({ code: "unapproved-device" });
          return token;
        },
      }),
    catch: (cause) =>
      cause instanceof PeerError ? cause : new PeerError({ code: "unapproved-device" }),
  });
  if (registeredAccountId !== input.accountId)
    return yield* new PeerError({ code: "unapproved-device" });
  const session = yield* connectRoute(identity, route);
  const registration = yield* ConnectionOnboarding.preparePairingRegistration({
    host: "http://127.0.0.1",
    pairingCode: payload.pairingToken,
    expectedEnvironmentId: payload.environmentId,
  }).pipe(
    Effect.provide(layerRemoteHttpClient(peerFetch(session, "http://127.0.0.1"))),
    Effect.ensuring(Effect.sync(() => session.close())),
  );
  const connectionId = `peer:${payload.host.deviceId}:${payload.environmentId}`;
  const next = new BearerConnectionRegistration({
    ...registration,
    target: new BearerConnectionTarget({ ...registration.target, connectionId }),
    profile: new BearerConnectionProfile({
      ...registration.profile,
      connectionId,
      peerDeviceId: payload.host.deviceId,
    }),
  });
  // Persist the pinned route without the one-time pairing code or Clerk token.
  const routes = yield* readRoutes();
  yield* storage.setItem(
    ROUTES_KEY,
    yield* encodeRoutes([
      ...routes.filter(
        (item) => item.environmentId !== route.environmentId || item.accountId !== input.accountId,
      ),
      route,
    ]),
  );
  yield* peers.register(route.host.deviceId, connectRoute(identity, route));
  yield* registry.register(next);
  yield* registry.setEnabled(payload.environmentId, true);
  yield* registry.retryNow(payload.environmentId);
  return payload.environmentId;
});
