import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { PeerError } from "@t3tools/contracts/minesPeer";
import { PeerConnections, type PeerSession } from "@t3tools/client-runtime/peer";
import {
  EnvironmentRegistry,
  type BearerConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { encodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "expo-crypto";
import * as Base64Url from "effect/encoding/Base64Url";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import { loadPeerIdentity, pairPhone, restorePhonePeers } from "./peerPairing";

vi.mock("expo-device", () => ({ deviceName: "Test phone", osName: "iOS" }));
vi.mock("expo-crypto", () => ({
  getRandomBytes: vi.fn(() => new Uint8Array(32).fill(5)),
  randomUUID: () => "00000000-0000-4000-8000-000000000005",
}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("../lib/minesPeer", () => ({ createMobilePeer: vi.fn() }));

const transport = vi.hoisted(() => ({
  register: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
  gatewayClose: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/peer", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/peer")>()),
  registerPeerDevice: transport.register,
  connectDirectPeer: transport.connect,
  openPeerSignalGateway: async () => ({ close: transport.gatewayClose }),
  peerFetch: () => transport.fetch,
}));

const host = createPeerIdentity(new Uint8Array(32).fill(8), "Desktop").device;
const environmentId = EnvironmentId.make("env-paired");
const pairingUrl = encodePeerPairing({
  version: 1,
  host,
  controlUrl: "https://account.example.com",
  stunServers: [],
  environmentId,
  pairingToken: "bootstrap-secret",
  expiresAt: "2099-01-01T00:00:00.000Z",
});

function fixture() {
  const secure = new Map<string, string>();
  const routes = new Map<string, Effect.Effect<PeerSession, PeerError>>();
  const registrations: BearerConnectionRegistration[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(MobileSecureStorage, {
      getItem: (key) => Effect.sync(() => secure.get(key) ?? null),
      setItem: (key, value) =>
        Effect.sync(() => {
          secure.set(key, value);
        }),
      removeItem: (key) =>
        Effect.sync(() => {
          secure.delete(key);
        }),
    }),
    Layer.succeed(PeerConnections, {
      clear: Effect.sync(() => routes.clear()),
      register: (id, connect) =>
        Effect.sync(() => {
          routes.set(id, connect);
          return () => {
            routes.delete(id);
          };
        }),
      connect: () => Effect.fail(new PeerError({ code: "direct-unavailable" })),
      subscribeSessions: () => () => {},
    }),
    Layer.succeed(ClientCapabilities.ClientPresentation, {
      metadata: { label: "Test phone", deviceType: "mobile", os: "iOS" },
    }),
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      register: (registration: BearerConnectionRegistration) =>
        Effect.sync(() => {
          registrations.push(registration);
          return true;
        }),
      setEnabled: () => Effect.void,
      retryNow: () => Effect.void,
    } as unknown as Effect.Success<typeof EnvironmentRegistry.EnvironmentRegistry>),
  );
  return { secure, routes, registrations, layer };
}

beforeEach(() => {
  vi.clearAllMocks();
  let sequence = 5;
  vi.mocked(Crypto.getRandomBytes).mockImplementation((length) =>
    new Uint8Array(length).fill(sequence++),
  );
  transport.register.mockImplementation(async (input: { bearerToken: () => Promise<string> }) => {
    expect(await input.bearerToken()).toBe("clerk-token");
    return "user-a";
  });
  transport.connect.mockResolvedValue({ remoteDeviceId: host.deviceId, close: transport.close });
  transport.fetch.mockImplementation(async (input: string) => {
    if (String(input).endsWith("/.well-known/mines/environment"))
      return Response.json({
        environmentId,
        label: "Desktop",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      });
    if (String(input).endsWith("/oauth/token"))
      return Response.json({
        access_token: "scoped-bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "threads:read",
      });
    throw new Error("Unexpected resource");
  });
});

describe("mobile peer pairing", () => {
  it.effect("rejects account changes before opening a peer or redeeming its pairing code", () => {
    const f = fixture();
    transport.register.mockResolvedValueOnce("user-b");
    return Effect.gen(function* () {
      const outcome = yield* pairPhone({
        pairingUrl,
        accountId: "user-a",
        getToken: async () => "clerk-token",
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(transport.connect).not.toHaveBeenCalled();
      expect(transport.fetch).not.toHaveBeenCalled();
      expect(f.registrations).toHaveLength(0);
      expect(f.secure.has("mines.peer.routes.v1")).toBe(false);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("keeps one private identity in secure storage across launches", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const first = yield* loadPeerIdentity("user-a");
      const next = yield* loadPeerIdentity("user-a");
      expect(next.device).toEqual(first.device);
      expect(f.secure.size).toBe(1);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "refreshes a generic phone label and platform while preserving its keys and custom name",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const first = yield* loadPeerIdentity("user-a");
        const key = [...f.secure.keys()][0]!;
        const privateKey = Base64Url.encode(first.privateKey);
        f.secure.set(key, JSON.stringify({ privateKey, label: "My phone" }));
        const refreshed = yield* loadPeerIdentity("user-a");
        expect(refreshed.device.label).toBe("Test phone");
        expect(refreshed.device.platform).toBe("ios");
        expect(refreshed.device.deviceId).toBe(first.device.deviceId);
        expect(refreshed.device.publicKey).toBe(first.device.publicKey);
        f.secure.set(key, JSON.stringify({ privateKey, label: "Travel phone" }));
        expect((yield* loadPeerIdentity("user-a")).device.label).toBe("Travel phone");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("keeps independent device keys for separate mines accounts", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const first = yield* loadPeerIdentity("user-a");
      const second = yield* loadPeerIdentity("user-b");
      const restored = yield* loadPeerIdentity("user-a");
      expect(second.device.deviceId).not.toBe(first.device.deviceId);
      expect(restored.device).toEqual(first.device);
      expect(f.secure.size).toBe(2);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "redeems the one-time token through the pinned peer and restores only its signed-in account",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* pairPhone({ pairingUrl, accountId: "user-a", getToken: async () => "clerk-token" });
        expect(transport.connect.mock.calls[0]?.[0].approved).toEqual(host);
        expect(transport.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
          "http://127.0.0.1/.well-known/mines/environment",
          "http://127.0.0.1/oauth/token",
        ]);
        expect(transport.close).toHaveBeenCalledOnce();
        expect(transport.gatewayClose).toHaveBeenCalledOnce();
        expect(f.registrations[0]?.profile.peerDeviceId).toBe(host.deviceId);
        expect(f.registrations[0]?.credential.token).toBe("scoped-bearer");
        const saved = f.secure.get("mines.peer.routes.v1")!;
        expect(saved).not.toContain("bootstrap-secret");
        expect(saved).not.toContain("clerk-token");
        expect(yield* restorePhonePeers("user-b")).toEqual([]);
        expect(f.routes.size).toBe(0);
        expect(yield* restorePhonePeers("user-a")).toEqual([environmentId]);
        expect(f.routes.has(host.deviceId)).toBe(true);
        expect(yield* restorePhonePeers(null)).toEqual([]);
        expect(f.routes.size).toBe(0);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("rejects a different environment before spending the one-time token", () => {
    const f = fixture();
    transport.fetch.mockResolvedValueOnce(
      Response.json({
        environmentId: "wrong-environment",
        label: "Other desktop",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      }),
    );
    return Effect.gen(function* () {
      const outcome = yield* pairPhone({
        pairingUrl,
        accountId: "user-a",
        getToken: async () => "clerk-token",
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(transport.fetch).toHaveBeenCalledOnce();
      expect(transport.close).toHaveBeenCalledOnce();
      expect(f.registrations).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("stops before resource access when direct negotiation fails", () => {
    const f = fixture();
    transport.connect.mockRejectedValueOnce(new PeerError({ code: "direct-unavailable" }));
    return Effect.gen(function* () {
      const outcome = yield* pairPhone({
        pairingUrl,
        accountId: "user-a",
        getToken: async () => "clerk-token",
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(transport.fetch).not.toHaveBeenCalled();
      expect(f.registrations).toHaveLength(0);
      expect(transport.gatewayClose).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(f.layer));
  });
});
