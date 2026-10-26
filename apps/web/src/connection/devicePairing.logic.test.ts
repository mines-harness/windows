import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  DevicePairingError,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import type { DevicePairingClientCollection } from "@t3tools/shared/minesDevicePairing";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { makeDevicePairingAdapter } from "./devicePairing.logic";

function promiseGate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const requester = createPeerIdentity(new Uint8Array(32).fill(1), "My Mac");
  const target = createPeerIdentity(new Uint8Array(32).fill(2), "OVH").device;
  const environmentId = EnvironmentId.make("ovh-environment");
  const keys: Uint8Array[] = [];
  const paired: string[] = [];
  let now = 1_000;
  let nextId = 0;
  const request = (): DevicePairingRequest => ({
    id: `request-${++nextId}`,
    code: "ABCD2345",
    expiresAt: new Date((now + 300) * 1000).toISOString(),
    requester: requester.device,
    target,
    responsePublicKey: "r".repeat(43),
    proof: {
      version: 1,
      action: "request",
      device: requester.device,
      nonce: "fixture-nonce",
      issuedAt: now,
      signature: "s".repeat(86),
      id: "fixture-proof",
      targetDeviceId: target.deviceId,
      responsePublicKey: "r".repeat(43),
    },
  });
  const dependencies = {
    identity: () => Effect.succeed(requester),
    begin: async () => {
      const privateKey = new Uint8Array(32).fill(9);
      keys.push(privateKey);
      return { request: request(), privateKey };
    },
    collect: async (): Promise<DevicePairingClientCollection> => ({ status: "pending" }),
    cancel: async () => {},
    pair: (input: { pairingUrl: string }) =>
      Effect.sync(() => {
        paired.push(input.pairingUrl);
        return environmentId;
      }),
    nowSeconds: () => now,
    randomId: () => "fixture-nonce",
  };
  const input = {
    accountId: "account-a",
    targetDeviceId: target.deviceId,
    controlUrl: "https://mines.example.test",
    getToken: async () => "private-account-token",
  };
  return { dependencies, input, environmentId, keys, paired, advance: () => (now += 301) };
}

it.effect("returns only public approval details and consumes an approved request once", () => {
  const test = fixture();
  test.dependencies.collect = async () => ({
    status: "approved",
    pairingUrl: "private-pairing-credential",
  });
  const adapter = makeDevicePairingAdapter(test.dependencies);
  return Effect.gen(function* () {
    yield* adapter.selectAccount("account-a");
    const request = yield* adapter.begin(test.input, () => true);
    assert.deepStrictEqual(Object.keys(request).sort(), [
      "code",
      "expiresAt",
      "id",
      "requester",
      "target",
    ]);
    assert.notInclude(JSON.stringify(request), "private-account-token");
    assert.notInclude(JSON.stringify(request), "responsePublicKey");
    const input = { ...test.input, requestId: request.id };
    assert.deepStrictEqual(yield* adapter.collect(input, () => true), {
      status: "connected",
      environmentId: test.environmentId,
    });
    assert.deepStrictEqual(yield* adapter.collect(input, () => true), { status: "expired" });
    assert.deepStrictEqual(test.paired, ["private-pairing-credential"]);
    assert.isTrue(test.keys[0]!.every((byte) => byte === 0));
  });
});

it.effect("expires private handles without contacting or connecting to the host", () => {
  const test = fixture();
  const adapter = makeDevicePairingAdapter(test.dependencies);
  return Effect.gen(function* () {
    yield* adapter.selectAccount("account-a");
    const request = yield* adapter.begin(test.input, () => true);
    test.advance();
    assert.deepStrictEqual(
      yield* adapter.collect({ ...test.input, requestId: request.id }, () => true),
      { status: "expired" },
    );
    assert.deepStrictEqual(test.paired, []);
    assert.isTrue(test.keys[0]!.every((byte) => byte === 0));
  });
});

it.effect("limits pending private requests per active account", () => {
  const test = fixture();
  const adapter = makeDevicePairingAdapter(test.dependencies);
  return Effect.gen(function* () {
    yield* adapter.selectAccount("account-a");
    for (let i = 0; i < 4; i++) yield* adapter.begin(test.input, () => true);
    const result = yield* Effect.result(adapter.begin(test.input, () => true));
    assert.isTrue(Result.isFailure(result));
    assert.lengthOf(test.keys, 4);
    yield* adapter.selectAccount(null);
    assert.isTrue(test.keys.every((key) => key.every((byte) => byte === 0)));
  });
});

it.effect("a request lost by the service expires locally and erases its private handle", () => {
  const test = fixture();
  test.dependencies.collect = async () => {
    throw new DevicePairingError({ code: "not-found" });
  };
  const adapter = makeDevicePairingAdapter(test.dependencies);
  return Effect.gen(function* () {
    yield* adapter.selectAccount("account-a");
    const request = yield* adapter.begin(test.input, () => true);
    assert.deepStrictEqual(
      yield* adapter.collect({ ...test.input, requestId: request.id }, () => true),
      { status: "expired" },
    );
    assert.isTrue(test.keys[0]!.every((byte) => byte === 0));
    assert.deepStrictEqual(test.paired, []);
  });
});

it.effect("an account switch discards an approval that arrives after its request was cleared", () =>
  Effect.gen(function* () {
    const test = fixture();
    const entered = promiseGate<void>();
    const response = promiseGate<DevicePairingClientCollection>();
    test.dependencies.collect = () => {
      entered.resolve(undefined);
      return response.promise;
    };
    const adapter = makeDevicePairingAdapter(test.dependencies);
    yield* adapter.selectAccount("account-a");
    const request = yield* adapter.begin(test.input, () => true);
    const collecting = yield* Effect.forkChild(
      adapter.collect({ ...test.input, requestId: request.id }, () => true),
    );
    yield* Effect.promise(() => entered.promise);
    yield* adapter.selectAccount("account-b");
    response.resolve({ status: "approved", pairingUrl: "must-not-be-used" });
    assert.deepStrictEqual(yield* Fiber.join(collecting), { status: "cancelled" });
    assert.deepStrictEqual(test.paired, []);
    assert.isTrue(test.keys[0]!.every((byte) => byte === 0));
  }),
);

it.effect("cancel aborts a collection immediately and ignores a late approval", () =>
  Effect.gen(function* () {
    const test = fixture();
    const entered = promiseGate<void>();
    const response = promiseGate<DevicePairingClientCollection>();
    let signal: AbortSignal | undefined;
    const dependencies = {
      ...test.dependencies,
      collect: (input: { signal?: AbortSignal }) => {
        signal = input.signal;
        entered.resolve(undefined);
        return response.promise;
      },
    };
    const adapter = makeDevicePairingAdapter(dependencies);
    yield* adapter.selectAccount("account-a");
    const request = yield* adapter.begin(test.input, () => true);
    const input = { ...test.input, requestId: request.id };
    const collecting = yield* Effect.forkChild(adapter.collect(input, () => true));
    yield* Effect.promise(() => entered.promise);
    yield* adapter.cancel(input);
    assert.isTrue(signal?.aborted);
    response.resolve({ status: "approved", pairingUrl: "must-not-be-used" });
    assert.deepStrictEqual(yield* Fiber.join(collecting), { status: "cancelled" });
    assert.deepStrictEqual(test.paired, []);
    assert.isTrue(test.keys[0]!.every((byte) => byte === 0));
  }),
);

it.effect("cancel also aborts a connection after approval without publishing its result", () =>
  Effect.gen(function* () {
    const test = fixture();
    const entered = promiseGate<void>();
    const release = promiseGate<void>();
    test.dependencies.collect = async () => ({ status: "approved", pairingUrl: "private-url" });
    let signal: AbortSignal | undefined;
    const adapter = makeDevicePairingAdapter({
      ...test.dependencies,
      pair: (input: { signal?: AbortSignal; isCurrent: () => boolean }) =>
        Effect.gen(function* () {
          signal = input.signal;
          entered.resolve(undefined);
          yield* Effect.promise(() => release.promise);
          return test.environmentId;
        }),
    });
    yield* adapter.selectAccount("account-a");
    const request = yield* adapter.begin(test.input, () => true);
    const input = { ...test.input, requestId: request.id };
    const collecting = yield* Effect.forkChild(adapter.collect(input, () => true));
    yield* Effect.promise(() => entered.promise);
    yield* adapter.cancel(input);
    assert.isTrue(signal?.aborted);
    release.resolve(undefined);
    assert.deepStrictEqual(yield* Fiber.join(collecting), { status: "cancelled" });
  }),
);
