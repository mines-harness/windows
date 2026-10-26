import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { PeerError } from "@t3tools/contracts/minesPeer";
import { PeerConnections, type PeerSession } from "@t3tools/client-runtime/peer";
import {
  EnvironmentRegistry,
  BearerConnectionTarget,
  type BearerConnectionRegistration,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { encodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import {
  loadBrowserPeerIdentity,
  pairBrowserPeer,
  restoreBrowserPeers,
  forgetBrowserPeer,
} from "./peerPairing";

const mock = vi.hoisted(() => ({
  stores: new Map<string, Map<string, Uint8Array>>(),
  register: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
  gatewayClose: vi.fn(),
  write: vi.fn(),
  afterRegister: vi.fn(),
}));
vi.mock("../catalog/storage", () => ({
  openBrowserPrivateStore: async (accountId: string) => {
    let store = mock.stores.get(accountId);
    if (!store) {
      store = new Map();
      mock.stores.set(accountId, store);
    }
    return {
      read: async (key: string) => store!.get(key) ?? null,
      write: async (key: string, value: Uint8Array) => {
        store!.set(key, value);
        await mock.write(accountId, key, value);
      },
    };
  },
}));
vi.mock("@t3tools/client-runtime/peer", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/peer")>()),
  registerPeerDevice: mock.register,
  connectDirectPeer: mock.connect,
  openPeerSignalGateway: async () => ({ close: mock.gatewayClose }),
  peerFetch: () => mock.fetch,
}));
afterEach(() => vi.unstubAllGlobals());
const host = createPeerIdentity(new Uint8Array(32).fill(9), "Other computer").device;
const environmentId = EnvironmentId.make("peer-computer");
const pairingUrl = encodePeerPairing({
  version: 1,
  host,
  controlUrl: "https://account.example.com",
  stunServers: [],
  environmentId,
  pairingToken: "bootstrap-secret",
  expiresAt: "2099-01-01T00:00:00.000Z",
});
function promiseGate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  mock.stores.clear();
  vi.clearAllMocks();
  mock.write.mockReset().mockResolvedValue(undefined);
  mock.afterRegister.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    platform: "MacIntel",
    maxTouchPoints: 0,
    locks: { request: async (_key: string, operation: () => Promise<unknown>) => operation() },
  });
  mock.register.mockResolvedValue("account-a");
  mock.connect.mockResolvedValue({ remoteDeviceId: host.deviceId, close: mock.close });
  mock.fetch.mockImplementation(async (input: string) => {
    if (String(input).endsWith("/.well-known/mines/environment"))
      return Response.json({
        environmentId,
        label: "Other computer",
        platform: { os: "linux", arch: "x64" },
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
  const routes = new Map<string, Effect.Effect<PeerSession, PeerError>>();
  const registrations: BearerConnectionRegistration[] = [];
  const removed: string[] = [];
  const removedRoutes: string[] = [];
  const layer = Layer.mergeAll(
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
      metadata: { label: "This computer", deviceType: "desktop", os: "macOS" },
    }),
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const entries = yield* SubscriptionRef.make(new Map());
        return {
          entries,
          register: (value: BearerConnectionRegistration) =>
            Effect.promise(async () => {
              registrations.push(value);
              await mock.afterRegister(value);
              return true;
            }),
          setEnabled: () => Effect.void,
          retryNow: () => Effect.void,
          remove: (id: string) =>
            Effect.sync(() => {
              removed.push(id);
            }),
          removeRoute: (_id: string, routeId: string) =>
            Effect.sync(() => {
              const index = registrations.findIndex(
                (entry) => entry.target.connectionId === routeId,
              );
              if (index !== -1) registrations.splice(index, 1);
              removedRoutes.push(routeId);
            }),
        } as unknown as Effect.Success<typeof EnvironmentRegistry.EnvironmentRegistry>;
      }),
    ),
  );
  return { routes, registrations, removed, removedRoutes, layer };
}
describe("browser and desktop direct pairing", () => {
  it.effect("uses the native desktop platform instead of its browser user agent", () => {
    fixture();
    vi.stubGlobal("window", {
      desktopBridge: { getClientPlatform: () => "win32" },
    });
    return Effect.gen(function* () {
      const identity = yield* loadBrowserPeerIdentity("account-a");
      expect(identity.device.platform).toBe("windows");
      expect(identity.device.label).toBe("Windows PC");
    });
  });
  it.effect("recognizes iPad desktop user agents and Android browsers", () => {
    fixture();
    return Effect.gen(function* () {
      vi.stubGlobal("navigator", { ...navigator, maxTouchPoints: 5 });
      const ipad = yield* loadBrowserPeerIdentity("account-a");
      expect(ipad.device.platform).toBe("ios");
      expect(ipad.device.label).toBe("iPad");
      vi.stubGlobal("navigator", {
        ...navigator,
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile",
        platform: "Linux armv8l",
      });
      const android = yield* loadBrowserPeerIdentity("account-b");
      expect(android.device.platform).toBe("android");
      expect(android.device.label).toBe("Android phone");
    });
  });
  it.effect("replaces only the old generic name while retaining its saved key", () => {
    fixture();
    return Effect.gen(function* () {
      const before = yield* loadBrowserPeerIdentity("account-a", "mines browser client");
      const after = yield* loadBrowserPeerIdentity("account-a");
      expect(after.device.label).toBe("Mac");
      expect(after.device.deviceId).toBe(before.device.deviceId);
      expect(after.device.publicKey).toBe(before.device.publicKey);
    });
  });
  it.effect("leaves unsupported browser platforms unspecified", () => {
    fixture();
    vi.stubGlobal("navigator", {
      ...navigator,
      userAgent: "Mozilla/5.0 (X11; CrOS x86_64)",
      platform: "Linux x86_64",
    });
    return Effect.gen(function* () {
      const identity = yield* loadBrowserPeerIdentity("account-a");
      expect(identity.device.platform).toBeUndefined();
      expect(identity.device.label).toBe("Browser");
    });
  });
  it.effect("refreshes platform metadata while preserving the saved key and custom name", () => {
    fixture();
    return Effect.gen(function* () {
      const before = yield* loadBrowserPeerIdentity("account-a", "My MacBook");
      vi.stubGlobal("window", {
        desktopBridge: { getClientPlatform: () => "darwin" },
      });
      const after = yield* loadBrowserPeerIdentity("account-a");
      expect(after.device.platform).toBe("macos");
      expect(after.device.deviceId).toBe(before.device.deviceId);
      expect(after.device.publicKey).toBe(before.device.publicKey);
      expect(after.device.label).toBe("My MacBook");
    });
  });
  it.effect("keeps device keys stable and separated by system account", () => {
    fixture();
    return Effect.gen(function* () {
      const first = yield* loadBrowserPeerIdentity("account-a");
      const second = yield* loadBrowserPeerIdentity("account-b");
      expect((yield* loadBrowserPeerIdentity("account-a")).device).toEqual(first.device);
      expect(second.device.deviceId).not.toBe(first.device.deviceId);
    });
  });
  it.effect("updates the displayed device name without replacing its account key", () => {
    fixture();
    return Effect.gen(function* () {
      const before = yield* loadBrowserPeerIdentity("account-a");
      const renamed = yield* loadBrowserPeerIdentity("account-a", "My MacBook");
      expect(renamed.device.deviceId).toBe(before.device.deviceId);
      expect(renamed.device.publicKey).toBe(before.device.publicKey);
      expect((yield* loadBrowserPeerIdentity("account-a")).device.label).toBe("My MacBook");
    });
  });
  it.effect("bounds device names to the peer contract without replacing the saved key", () => {
    fixture();
    return Effect.gen(function* () {
      const before = yield* loadBrowserPeerIdentity("account-a");
      const renamed = yield* loadBrowserPeerIdentity("account-a", `  ${"x".repeat(100)}  `);
      expect(renamed.device.label).toBe("x".repeat(80));
      expect(renamed.device.deviceId).toBe(before.device.deviceId);
      expect((yield* loadBrowserPeerIdentity("account-a")).device.label).toBe("x".repeat(80));
    });
  });
  it.effect(
    "pairs through the pinned peer, restores only the account's routes, and forgets it",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* pairBrowserPeer({
          accountId: "account-a",
          pairingUrl,
          getToken: async () => "clerk-token",
        });
        expect(mock.connect.mock.calls[0]?.[0].approved).toEqual(host);
        expect(mock.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
          "http://127.0.0.1/.well-known/mines/environment",
          "http://127.0.0.1/oauth/token",
        ]);
        expect(f.registrations[0]?.profile.peerDeviceId).toBe(host.deviceId);
        expect(f.registrations[0]?.credential.token).toBe("scoped-bearer");
        const stored = new TextDecoder().decode(
          mock.stores.get("account-a")?.get("peer.routes.v1"),
        );
        expect(stored).not.toContain("bootstrap-secret");
        expect(stored).not.toContain("clerk-token");
        expect(stored).not.toContain("scoped-bearer");
        expect(yield* restoreBrowserPeers("account-b")).toEqual([]);
        expect(f.routes.size).toBe(0);
        expect(yield* restoreBrowserPeers("account-a")).toEqual([environmentId]);
        expect(yield* forgetBrowserPeer({ accountId: "account-a", environmentId })).toEqual([]);
        expect(f.routes.size).toBe(0);
        expect(f.removed).toEqual([environmentId]);
        expect(mock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect("rejects mismatched account registration before using the pairing code", () => {
    const f = fixture();
    mock.register.mockResolvedValueOnce("account-b");
    return Effect.gen(function* () {
      const outcome = yield* pairBrowserPeer({
        accountId: "account-a",
        pairingUrl,
        getToken: async () => "clerk-token",
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(mock.connect).not.toHaveBeenCalled();
      expect(mock.fetch).not.toHaveBeenCalled();
      expect(f.registrations).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("never redeems or persists a route when direct negotiation fails", () => {
    const f = fixture();
    mock.connect.mockRejectedValueOnce(new PeerError({ code: "direct-unavailable" }));
    return Effect.gen(function* () {
      const outcome = yield* pairBrowserPeer({
        accountId: "account-a",
        pairingUrl,
        getToken: async () => "clerk-token",
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(mock.fetch).not.toHaveBeenCalled();
      expect(f.registrations).toHaveLength(0);
      expect(mock.stores.get("account-a")?.has("peer.routes.v1")).toBe(false);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect(
    "cancel during direct negotiation closes the late session without redeeming access",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const entered = promiseGate<void>();
        const released = promiseGate<PeerSession>();
        const controller = new AbortController();
        mock.connect.mockImplementationOnce(() => {
          entered.resolve(undefined);
          return released.promise;
        });
        const pairing = yield* Effect.forkChild(
          pairBrowserPeer({
            accountId: "account-a",
            pairingUrl,
            getToken: async () => "account-token",
            signal: controller.signal,
          }).pipe(Effect.exit),
        );
        yield* Effect.promise(() => entered.promise);
        controller.abort();
        released.resolve({
          remoteDeviceId: host.deviceId,
          close: mock.close,
          send: async () => {},
          subscribe: () => () => {},
          closed: Promise.resolve(),
        });
        expect((yield* Fiber.join(pairing))._tag).toBe("Failure");
        expect(mock.fetch).not.toHaveBeenCalled();
        expect(test.registrations).toHaveLength(0);
        expect(mock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect(
    "an account switch before registration does not save a route or publish credentials",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        const entered = promiseGate<void>();
        const released = promiseGate<void>();
        let active = true;
        const original = mock.fetch.getMockImplementation()!;
        mock.fetch.mockImplementation(async (input: string) => {
          if (String(input).endsWith("/oauth/token")) {
            entered.resolve(undefined);
            await released.promise;
          }
          return original(input);
        });
        const pairing = yield* Effect.forkChild(
          pairBrowserPeer({
            accountId: "account-a",
            pairingUrl,
            getToken: async () => "account-token",
            isCurrent: () => active,
          }).pipe(Effect.exit),
        );
        yield* Effect.promise(() => entered.promise);
        active = false;
        released.resolve(undefined);
        expect((yield* Fiber.join(pairing))._tag).toBe("Failure");
        expect(test.registrations).toHaveLength(0);
        expect(mock.stores.get("account-a")?.has("peer.routes.v1")).toBe(false);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect("cancel during route persistence restores the previous saved route", () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* loadBrowserPeerIdentity("account-a");
      const previous = {
        host: createPeerIdentity(new Uint8Array(32).fill(7), "Previous computer").device,
        controlUrl: "https://account.example.com",
        stunServers: [],
        environmentId,
      };
      const stored = mock.stores.get("account-a")!;
      stored.set("peer.routes.v1", new TextEncoder().encode(JSON.stringify([previous])));
      const entered = promiseGate<void>();
      const release = promiseGate<void>();
      let first = true;
      mock.write.mockImplementation(async (_account: string, key: string) => {
        if (key === "peer.routes.v1" && first) {
          first = false;
          entered.resolve(undefined);
          await release.promise;
        }
      });
      const controller = new AbortController();
      const pairing = yield* Effect.forkChild(
        pairBrowserPeer({
          accountId: "account-a",
          pairingUrl,
          getToken: async () => "account-token",
          signal: controller.signal,
        }).pipe(Effect.exit),
      );
      yield* Effect.promise(() => entered.promise);
      controller.abort();
      release.resolve(undefined);
      expect((yield* Fiber.join(pairing))._tag).toBe("Failure");
      expect(JSON.parse(new TextDecoder().decode(stored.get("peer.routes.v1")))).toEqual([
        previous,
      ]);
      expect(test.registrations).toHaveLength(0);
      expect(test.routes.has(host.deviceId)).toBe(false);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("cancel does not erase a newer route saved while its write was finishing", () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* loadBrowserPeerIdentity("account-a");
      const entered = promiseGate<void>();
      const release = promiseGate<void>();
      let first = true;
      mock.write.mockImplementation(async (_account: string, key: string) => {
        if (key === "peer.routes.v1" && first) {
          first = false;
          entered.resolve(undefined);
          await release.promise;
        }
      });
      const controller = new AbortController();
      const pairing = yield* Effect.forkChild(
        pairBrowserPeer({
          accountId: "account-a",
          pairingUrl,
          getToken: async () => "account-token",
          signal: controller.signal,
        }).pipe(Effect.exit),
      );
      yield* Effect.promise(() => entered.promise);
      const newer = {
        host,
        controlUrl: "https://account.example.com",
        stunServers: [],
        environmentId,
        setupId: "newer-attempt",
      };
      const stored = mock.stores.get("account-a")!;
      stored.set("peer.routes.v1", new TextEncoder().encode(JSON.stringify([newer])));
      controller.abort();
      release.resolve(undefined);
      expect((yield* Fiber.join(pairing))._tag).toBe("Failure");
      expect(JSON.parse(new TextDecoder().decode(stored.get("peer.routes.v1")))).toEqual([newer]);
      expect(test.registrations).toHaveLength(0);
      expect(test.routes.has(host.deviceId)).toBe(true);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("interruption during persistence runs the attempt cleanup before completing", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const entered = promiseGate<void>();
      const release = promiseGate<void>();
      let first = true;
      mock.write.mockImplementation(async (_account: string, key: string) => {
        if (key === "peer.routes.v1" && first) {
          first = false;
          entered.resolve(undefined);
          await release.promise;
        }
      });
      const pairing = yield* Effect.forkChild(
        pairBrowserPeer({
          accountId: "account-a",
          pairingUrl,
          getToken: async () => "account-token",
          isCurrent: () => true,
        }),
      );
      yield* Effect.promise(() => entered.promise);
      // The write gate stays closed until the interruption has been requested.
      pairing.interruptUnsafe();
      release.resolve(undefined);
      expect((yield* Fiber.await(pairing))._tag).toBe("Failure");
      expect(test.registrations).toHaveLength(0);
      const stored = mock.stores.get("account-a")!.get("peer.routes.v1");
      expect(JSON.parse(new TextDecoder().decode(stored))).toEqual([]);
      expect(test.routes.size).toBe(0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("the account pairing flow preserves an already added environment", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const target = new BearerConnectionTarget({
        environmentId,
        connectionId: "existing-connection",
        label: "Existing computer",
      });
      const entry = { target, profile: Option.none(), enabled: true };
      yield* SubscriptionRef.set(registry.entries, new Map([[environmentId, entry]]));
      const outcome = yield* pairBrowserPeer({
        accountId: "account-a",
        pairingUrl,
        getToken: async () => "account-token",
        isCurrent: () => true,
      }).pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect((yield* SubscriptionRef.get(registry.entries)).get(environmentId)).toBe(entry);
      expect(mock.fetch).not.toHaveBeenCalled();
      expect(test.registrations).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect(
    "cancel during registration removes only the new attempt and restores its old route",
    () => {
      const test = fixture();
      return Effect.gen(function* () {
        yield* loadBrowserPeerIdentity("account-a");
        const previous = {
          host: createPeerIdentity(new Uint8Array(32).fill(7), "Previous computer").device,
          controlUrl: "https://account.example.com",
          stunServers: [],
          environmentId,
        };
        const stored = mock.stores.get("account-a")!;
        stored.set("peer.routes.v1", new TextEncoder().encode(JSON.stringify([previous])));
        const entered = promiseGate<void>();
        const release = promiseGate<void>();
        mock.afterRegister.mockImplementationOnce(async () => {
          entered.resolve(undefined);
          await release.promise;
        });
        const controller = new AbortController();
        const pairing = yield* Effect.forkChild(
          pairBrowserPeer({
            accountId: "account-a",
            pairingUrl,
            getToken: async () => "account-token",
            signal: controller.signal,
          }).pipe(Effect.exit),
        );
        yield* Effect.promise(() => entered.promise);
        const attemptedId = test.registrations[0]!.target.connectionId;
        controller.abort();
        release.resolve(undefined);
        expect((yield* Fiber.join(pairing))._tag).toBe("Failure");
        expect(test.registrations).toHaveLength(0);
        expect(test.removedRoutes).toEqual([attemptedId]);
        expect(attemptedId).toMatch(new RegExp(`^peer:${host.deviceId}:${environmentId}:`));
        expect(JSON.parse(new TextDecoder().decode(stored.get("peer.routes.v1")))).toEqual([
          previous,
        ]);
        expect(test.routes.has(host.deviceId)).toBe(false);
      }).pipe(Effect.provide(test.layer));
    },
  );
});
