import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthAccessWriteScope, EnvironmentId } from "@t3tools/contracts";
import {
  DevicePairingError,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import { PeerError, type PeerConnectionState } from "@t3tools/contracts/minesPeer";
import { decodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HostSignalingService from "./HostSignalingService.ts";
import * as PeerHost from "./PeerHost.ts";
import * as PeerPairing from "./PeerPairing.ts";
import * as PeerPairingControl from "./PeerPairingControl.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";

const requester = createPeerIdentity(new Uint8Array(32).fill(37), "Mac").device;
const configured: PeerConnectionState = {
  configured: true,
  online: true,
  controlUrl: "https://devices.example.test",
  accountId: "first-account",
  stunServers: ["stun:devices.example.test:3478"],
  failure: null,
};
const input = { code: "ABCDEFGH", scopes: [AuthAccessWriteScope] };

const fixture = (
  options: {
    readonly beforeReview?: Effect.Effect<void>;
    readonly beforeComplete?: Effect.Effect<void>;
    readonly failComplete?: boolean;
    readonly wrongTarget?: boolean;
    readonly expired?: boolean;
    readonly beforeGrant?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(configured);
    let reviews = 0;
    let disconnects = 0;
    const completed: string[] = [];
    const denied: string[] = [];
    const trust = PeerTrustStore.layer.pipe(Layer.provide(ServerSecretStore.layer));
    const control = Layer.effect(
      PeerPairingControl.PeerPairingControl,
      Effect.gen(function* () {
        const store = yield* PeerTrustStore.PeerTrustStore;
        yield* store.selectAccount("first-account");
        const request = Effect.gen(function* () {
          const target = (yield* store.identity).device;
          const expiresAt = DateTime.formatIso(
            DateTime.makeUnsafe(
              (yield* Clock.currentTimeMillis) + (options.expired ? -1 : 300_000),
            ),
          );
          return {
            id: "request-1234567890123456",
            code: "ABCDEFGH",
            expiresAt,
            requester,
            target: options.wrongTarget ? requester : target,
            responsePublicKey: "a".repeat(43),
            proof: {
              version: 1,
              device: requester,
              nonce: "nonce-1234567890123456",
              issuedAt: 0,
              signature: "a".repeat(86),
              action: "request",
              id: "request-1234567890123456",
              targetDeviceId: target.deviceId,
              responsePublicKey: "a".repeat(43),
            },
          } satisfies DevicePairingRequest;
        }).pipe(Effect.orDie);
        return {
          pending: () => request.pipe(Effect.map((value) => [value])),
          review: () =>
            Effect.gen(function* () {
              reviews++;
              const value = yield* request;
              yield* options.beforeReview ?? Effect.void;
              return value;
            }),
          complete: (value) =>
            Effect.gen(function* () {
              completed.push(value.pairingUrl);
              yield* options.beforeComplete ?? Effect.void;
              if (options.failComplete)
                return yield* new DevicePairingError({ code: "unavailable" });
            }),
          deny: (value) =>
            Effect.sync(() => {
              denied.push(value.code);
            }),
        } satisfies PeerPairingControl.PeerPairingControl["Service"];
      }),
    ).pipe(Layer.provide(trust));
    const environmentId = EnvironmentId.make("pairing-environment");
    const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("Unused descriptor"),
    });
    const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    });
    const authBase = EnvironmentAuth.layer.pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(identity),
    );
    const auth = Layer.effect(
      EnvironmentAuth.EnvironmentAuth,
      Effect.gen(function* () {
        const base = yield* EnvironmentAuth.EnvironmentAuth;
        return {
          ...base,
          createPairingLink: Effect.fn("fixture.createPairingLink")(
            (value: Parameters<typeof base.createPairingLink>[0]) =>
              (options.beforeGrant ?? Effect.void).pipe(
                Effect.andThen(base.createPairingLink(value)),
              ),
          ),
        };
      }),
    ).pipe(Layer.provide(authBase));
    const dependencies = Layer.mergeAll(
      trust,
      auth,
      control,
      environment,
      Layer.succeed(PeerHost.PeerHost, {
        accept: () => Effect.fail(new PeerError({ code: "closed" })),
        disconnectDevice: () =>
          Effect.sync(() => {
            disconnects++;
          }),
      }),
      Layer.succeed(HostSignalingService.HostSignalingService, {
        configure: () => Effect.void,
        disable: Effect.void,
        start: Effect.void,
        state,
        connect: () => Effect.fail(new PeerError({ code: "closed" })),
        authorizeSharedGroup: () => Effect.fail(new PeerError({ code: "closed" })),
        connectSharedGroup: () => Effect.fail(new PeerError({ code: "closed" })),
        subscribeSharedGroupSessions: () => () => {},
        subscribeSessions: () => () => {},
        disconnectDevice: () =>
          Effect.sync(() => {
            disconnects++;
          }),
      }),
    );
    return {
      completed,
      denied,
      reviews: () => reviews,
      disconnects: () => disconnects,
      switchAccount: Effect.gen(function* () {
        const store = yield* PeerTrustStore.PeerTrustStore;
        yield* store.selectAccount("second-account");
        yield* SubscriptionRef.set(state, { ...configured, accountId: "second-account" });
      }),
      layer: PeerPairing.layer.pipe(
        Layer.provideMerge(dependencies),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "mines-pairing-test-" }),
        ),
        Layer.provide(Layer.succeed(HostProcess.Hostname, "OVH")),
        Layer.provide(NodeServices.layer),
      ),
    };
  });

it.effect("lists incoming requests without trusting a device or creating access grants", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* PeerTrustStore.PeerTrustStore;
      expect((yield* service.pending).map((request) => request.code)).toEqual(["ABCDEFGH"]);
      expect(yield* trust.list).toEqual([]);
      expect(yield* auth.listPairingLinks()).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("approves only explicitly delegated scopes and returns no pairing secret", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* PeerTrustStore.PeerTrustStore;
      expect(yield* service.approve(input, [AuthAccessWriteScope])).toEqual({
        code: input.code,
        requester,
      });
      expect(yield* trust.list).toEqual([requester]);
      const grants = yield* auth.listPairingLinks();
      expect(grants).toHaveLength(1);
      expect(grants[0]?.scopes).toEqual([AuthAccessWriteScope]);
      const payload = decodePeerPairing(f.completed[0]!, (yield* Clock.currentTimeMillis) / 1000);
      expect(payload.host.label).toBe("OVH");
      expect(payload.environmentId).toBe("pairing-environment");
      expect(payload.stunServers).toEqual(configured.stunServers);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("rejects scope escalation before reviewing or granting a request", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const result = yield* Effect.result(
        service.approve({ ...input, scopes: ["filesystem:write"] }, [AuthAccessWriteScope]),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } });
      expect(f.reviews()).toBe(0);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("revokes a new grant and approval when completion fails", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ failComplete: true });
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* PeerTrustStore.PeerTrustStore;
      const result = yield* Effect.result(service.approve(input, [AuthAccessWriteScope]));
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } });
      expect(yield* auth.listPairingLinks()).toEqual([]);
      expect(yield* trust.list).toEqual([]);
      expect(f.disconnects()).toBe(2);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("preserves an existing approval when a later pairing attempt fails", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ failComplete: true });
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const trust = yield* PeerTrustStore.PeerTrustStore;
      yield* trust.approve(requester);
      yield* Effect.result(service.approve(input, [AuthAccessWriteScope]));
      expect(yield* trust.list).toEqual([requester]);
      expect(f.disconnects()).toBe(0);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("cleans up a new grant and trust when approval is interrupted", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = yield* fixture({
      beforeComplete: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* PeerTrustStore.PeerTrustStore;
      const operation = yield* Effect.forkChild(service.approve(input, [AuthAccessWriteScope]));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(operation);
      expect(yield* auth.listPairingLinks()).toEqual([]);
      expect(yield* trust.list).toEqual([]);
      expect(f.disconnects()).toBe(2);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("does not issue access for an expired request", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ expired: true });
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      expect(yield* Effect.result(service.approve(input, [AuthAccessWriteScope]))).toMatchObject({
        _tag: "Failure",
        failure: { code: "expired" },
      });
      expect(yield* auth.listPairingLinks()).toEqual([]);
      expect(f.completed).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "a revocation during grant creation prevents the pending approval from restoring access",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* fixture({
        beforeGrant: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      yield* Effect.gen(function* () {
        const service = yield* PeerPairing.PeerPairing;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const trust = yield* PeerTrustStore.PeerTrustStore;
        yield* trust.approve(requester);
        const operation = yield* Effect.forkChild(
          Effect.result(service.approve(input, [AuthAccessWriteScope])),
        );
        yield* Deferred.await(entered);
        yield* trust.revoke(requester.deviceId);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(operation)).toMatchObject({
          _tag: "Failure",
          failure: { code: "forbidden" },
        });
        expect(yield* trust.list).toEqual([]);
        expect(yield* auth.listPairingLinks()).toEqual([]);
        expect(f.completed).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("does not grant a request after its account changes during review", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = yield* fixture({
      beforeReview: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const operation = yield* Effect.forkChild(
        Effect.result(service.approve(input, [AuthAccessWriteScope])),
      );
      yield* Deferred.await(entered);
      yield* f.switchAccount;
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(operation)).toMatchObject({
        _tag: "Failure",
        failure: { code: "forbidden" },
      });
      expect(yield* auth.listPairingLinks()).toEqual([]);
      expect(f.completed).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("rolls back original-account access without revoking the newly selected account", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = yield* fixture({
      beforeComplete: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* PeerTrustStore.PeerTrustStore;
      const operation = yield* Effect.forkChild(
        Effect.result(service.approve(input, [AuthAccessWriteScope])),
      );
      yield* Deferred.await(entered);
      yield* f.switchAccount;
      yield* trust.approve(requester);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(operation)).toMatchObject({
        _tag: "Failure",
        failure: { code: "forbidden" },
      });
      expect(yield* auth.listPairingLinks()).toEqual([]);
      expect(yield* trust.list).toEqual([requester]);
      yield* trust.selectAccount("first-account");
      expect(yield* trust.list).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("rejects a request addressed to another device", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ wrongTarget: true });
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      expect(yield* Effect.result(service.approve(input, [AuthAccessWriteScope]))).toMatchObject({
        _tag: "Failure",
        failure: { code: "forbidden" },
      });
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("denies a request without creating trust or an access grant", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      const service = yield* PeerPairing.PeerPairing;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* PeerTrustStore.PeerTrustStore;
      yield* service.deny({ code: input.code });
      expect(f.denied).toEqual([input.code]);
      expect(yield* trust.list).toEqual([]);
      expect(yield* auth.listPairingLinks()).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  }),
);
