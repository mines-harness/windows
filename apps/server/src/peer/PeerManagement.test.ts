import { expect, it } from "@effect/vitest";
import { PeerError, type PeerConnectionState, type PeerDevice } from "@t3tools/contracts/minesPeer";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import type { PeerSession } from "@t3tools/shared/minesPeerTransport";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as PeerManagement from "./PeerManagement.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";
import * as PeerHost from "./PeerHost.ts";
import * as HostSignalingService from "./HostSignalingService.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

const local = createPeerIdentity(new Uint8Array(32).fill(10), "Mac");
const remote = createPeerIdentity(new Uint8Array(32).fill(11), "Host");
const unknown = createPeerIdentity(new Uint8Array(32).fill(12), "Unapproved");

function session(deviceId: string) {
  const ended = Promise.withResolvers<void>();
  let closes = 0;
  return {
    remoteDeviceId: deviceId,
    closed: ended.promise,
    close: () => {
      closes++;
      ended.resolve();
    },
    send: async () => {},
    subscribe: () => () => {},
    get closes() {
      return closes;
    },
  } satisfies PeerSession & { readonly closes: number };
}

const fixture = (existing?: PeerSession, fail = false, beforeConnect = Effect.void) =>
  Effect.gen(function* () {
    let connections = 0;
    let identity = local;
    let approved: ReadonlyArray<PeerDevice> = [remote.device];
    const opened = session(remote.device.deviceId);
    const state = yield* SubscriptionRef.make<PeerConnectionState>({
      configured: true,
      online: true,
      controlUrl: "https://devices.example.com",
      accountId: "account",
      stunServers: [],
      failure: null,
    });
    const signaling = HostSignalingService.HostSignalingService.of({
      configure: () => Effect.void,
      disable: Effect.void,
      start: Effect.void,
      state,
      disconnectDevice: () => Effect.void,
      authorizeSharedGroup: () => Effect.die("Unused shared group authorization"),
      connectSharedGroup: () => Effect.die("Unused shared group connection"),
      subscribeSharedGroupSessions: () => () => {},
      subscribeSessions: (listener) => {
        if (existing) listener(existing);
        return () => {};
      },
      connect: () =>
        Effect.gen(function* () {
          connections++;
          yield* beforeConnect;
          if (fail) return yield* new PeerError({ code: "direct-unavailable" });
          return yield* Effect.acquireRelease(Effect.succeed(opened), (value) =>
            Effect.sync(value.close),
          );
        }),
    });
    const trust = PeerTrustStore.PeerTrustStore.of({
      identity: Effect.sync(() => identity),
      list: Effect.sync(() => approved),
      selectAccount: () => Effect.void,
      approve: () => Effect.void,
      beginApproval: () => Effect.die("Unused pairing approval"),
      revoke: () => Effect.void,
    });
    const deps = Layer.mergeAll(
      Layer.succeed(HostSignalingService.HostSignalingService, signaling),
      Layer.succeed(PeerTrustStore.PeerTrustStore, trust),
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        listPairingLinks: () => Effect.succeed([]),
        listSessions: () => Effect.succeed([]),
        revokeDevicePairingAccess: () => Effect.void,
      }),
      Layer.succeed(PeerHost.PeerHost, {
        accept: () => Effect.fail(new PeerError({ code: "closed" })),
        disconnectDevice: () => Effect.void,
      }),
    );
    return {
      layer: PeerManagement.layer.pipe(Layer.provide(deps)),
      opened,
      connections: () => connections,
      switchAccount: (nextIdentity: typeof local, devices: ReadonlyArray<PeerDevice>) =>
        Effect.sync(() => {
          identity = nextIdentity;
          approved = devices;
        }),
    };
  });

it.effect("does not reuse reachability results after an account identity changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const peers = yield* PeerManagement.PeerManagement;
        yield* peers.checkDevice({ deviceId: remote.device.deviceId });
        yield* f.switchAccount(unknown, [remote.device]);
        expect((yield* peers.status).devices[0]?.status).toBe("not-tested");
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.effect("rejects a completed check when account membership changes during the handshake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* fixture(
        undefined,
        false,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      yield* Effect.gen(function* () {
        const peers = yield* PeerManagement.PeerManagement;
        const checking = yield* Effect.forkChild(
          peers.checkDevice({ deviceId: remote.device.deviceId }),
        );
        yield* Deferred.await(entered);
        yield* f.switchAccount(unknown, []);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(checking)).status).toBe("approval-required");
        expect(f.opened.closes).toBe(1);
        expect((yield* peers.status).devices).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.effect("does not call a device reachable merely because signaling is online", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        const peers = yield* PeerManagement.PeerManagement;
        expect((yield* peers.status).devices).toEqual([
          { device: remote.device, status: "not-tested", checkedAt: null, failure: null },
        ]);
        expect(f.connections()).toBe(0);
        const checked = yield* peers.checkDevice({ deviceId: remote.device.deviceId });
        expect(checked.status).toBe("reachable");
        expect(f.opened.closes).toBe(1);
        expect((yield* peers.status).devices[0]?.status).toBe("reachable");
        yield* TestClock.adjust("61 seconds");
        expect((yield* peers.status).devices[0]?.status).toBe("not-tested");
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.effect("reports an existing direct session and stops calling it connected after it closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const active = session(remote.device.deviceId);
      const f = yield* fixture(active);
      yield* Effect.gen(function* () {
        const peers = yield* PeerManagement.PeerManagement;
        expect((yield* peers.status).devices[0]?.status).toBe("connected");
        expect((yield* peers.checkDevice({ deviceId: remote.device.deviceId })).status).toBe(
          "connected",
        );
        expect(f.connections()).toBe(0);
        active.close();
        yield* Effect.promise(() => active.closed);
        expect((yield* peers.status).devices[0]?.status).toBe("not-tested");
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);

it.effect("does not connect to unapproved devices and reports a failed direct check honestly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture(undefined, true);
      yield* Effect.gen(function* () {
        const peers = yield* PeerManagement.PeerManagement;
        expect((yield* peers.checkDevice({ deviceId: unknown.device.deviceId })).status).toBe(
          "approval-required",
        );
        expect(f.connections()).toBe(0);
        expect(yield* peers.checkDevice({ deviceId: remote.device.deviceId })).toMatchObject({
          status: "unavailable",
          failure: "direct-unavailable",
        });
        expect((yield* peers.status).devices[0]?.status).toBe("unavailable");
      }).pipe(Effect.provide(f.layer));
    }),
  ),
);
