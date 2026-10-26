import { expect, it } from "@effect/vitest";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PeerTrustStore from "./PeerTrustStore.ts";

function memorySecrets() {
  const stored = new Map<string, Uint8Array>();
  let sequence = 0;
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
    getOrCreateRandom: (name, size) =>
      Effect.sync(() => {
        const saved = stored.get(name);
        if (saved) return saved;
        const value = new Uint8Array(size).fill(++sequence);
        stored.set(name, value);
        return value;
      }),
  });
}

it.effect("binds approval and rollback to the original account when selection changes", () =>
  Effect.gen(function* () {
    const trust = yield* PeerTrustStore.PeerTrustStore;
    const phone = createPeerIdentity(new Uint8Array(32).fill(98), "Phone").device;
    yield* trust.selectAccount("first");
    const first = (yield* trust.identity).device;
    const account = { accountId: "first", deviceId: first.deviceId };
    yield* trust.approve(phone, account);
    yield* trust.selectAccount("second");
    yield* trust.approve(phone);
    const denied = yield* Effect.result(trust.approve(phone, account));
    expect(denied).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "PeerTrustAccountChangedError" },
    });
    yield* trust.revoke(phone.deviceId, account);
    expect(yield* trust.list).toEqual([phone]);
    yield* trust.selectAccount("first");
    expect(yield* trust.list).toEqual([]);
  }).pipe(Effect.provide(PeerTrustStore.layer.pipe(Layer.provide(memorySecrets())))),
);

it.effect("uses the host name without changing the stored device key", () =>
  Effect.gen(function* () {
    const secrets = memorySecrets();
    const load = (label: string, platform: NodeJS.Platform = "linux") =>
      Effect.flatMap(PeerTrustStore.PeerTrustStore, (trust) => trust.identity).pipe(
        Effect.provide(
          PeerTrustStore.layer.pipe(
            Layer.provide(secrets),
            Layer.provide(Layer.succeed(HostProcess.Hostname, label)),
            Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
          ),
        ),
      );
    const before = yield* load("OVH");
    const after = yield* load("My server");
    expect(after.device.deviceId).toBe(before.device.deviceId);
    expect(after.device.publicKey).toBe(before.device.publicKey);
    expect(before.device.label).toBe("OVH");
    expect(after.device.label).toBe("My server");
    expect(after.device.platform).toBe("linux");
    expect((yield* load("My Mac", "darwin")).device.platform).toBe("macos");
    expect((yield* load("My PC", "win32")).device.platform).toBe("windows");
  }),
);

it.effect("does not restore a revoked existing approval or undo a newer approval", () =>
  Effect.gen(function* () {
    const trust = yield* PeerTrustStore.PeerTrustStore;
    const phone = createPeerIdentity(new Uint8Array(32).fill(97), "Phone").device;
    yield* trust.selectAccount("account");
    const account = { accountId: "account", deviceId: (yield* trust.identity).device.deviceId };
    yield* trust.approve(phone);
    const existing = yield* trust.beginApproval(phone, account);
    yield* trust.revoke(phone.deviceId);
    expect(yield* existing.rollback).toBe(false);
    expect(yield* trust.list).toEqual([]);
    const added = yield* trust.beginApproval(phone, account);
    yield* trust.approve(phone);
    expect(yield* added.rollback).toBe(false);
    expect(yield* trust.list).toEqual([phone]);
  }).pipe(Effect.provide(PeerTrustStore.layer.pipe(Layer.provide(memorySecrets())))),
);

it.effect("keeps host identities and approved devices isolated across accounts and restarts", () =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    let sequence = 0;
    const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          stored.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          stored.set(name, value);
        }),
      remove: (name) =>
        Effect.sync(() => {
          stored.delete(name);
        }),
      getOrCreateRandom: (name, size) =>
        Effect.sync(() => {
          const existing = stored.get(name);
          if (existing) return existing;
          const value = new Uint8Array(size).fill(++sequence);
          stored.set(name, value);
          return value;
        }),
    });
    const phone = createPeerIdentity(new Uint8Array(32).fill(99), "Phone").device;
    const first = yield* Effect.gen(function* () {
      const trust = yield* PeerTrustStore.PeerTrustStore;
      yield* trust.selectAccount("account-a");
      const identity = yield* trust.identity;
      yield* trust.approve(phone);
      yield* trust.selectAccount("account-b");
      expect((yield* trust.identity).device.deviceId).not.toBe(identity.device.deviceId);
      expect(yield* trust.list).toEqual([]);
      yield* trust.selectAccount(null);
      expect(yield* trust.list).toEqual([]);
      yield* trust.selectAccount("account-a");
      expect((yield* trust.identity).device).toEqual(identity.device);
      expect(yield* trust.list).toEqual([phone]);
      return identity;
    }).pipe(Effect.provide(PeerTrustStore.layer.pipe(Layer.provide(secrets))));
    yield* Effect.gen(function* () {
      const trust = yield* PeerTrustStore.PeerTrustStore;
      expect((yield* trust.identity).device).toEqual(first.device);
      expect(yield* trust.list).toEqual([phone]);
      yield* trust.revoke(phone.deviceId);
      expect(yield* trust.list).toEqual([]);
    }).pipe(Effect.provide(PeerTrustStore.layer.pipe(Layer.provide(secrets))));
  }),
);
