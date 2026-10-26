import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import type { DevicePairingRequest } from "@t3tools/contracts/minesDevicePairing";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import { signDevicePairingCommand } from "@t3tools/shared/minesDevicePairing";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DevicePairing from "./DevicePairing.ts";

const requester = createPeerIdentity(new Uint8Array(32).fill(1), "MacBook");
const host = createPeerIdentity(new Uint8Array(32).fill(2), "OVH");
const other = createPeerIdentity(new Uint8Array(32).fill(3), "Other device");
const foreign = createPeerIdentity(new Uint8Array(32).fill(4), "Other account");
const envelope = { publicKey: "k".repeat(43), nonce: "n".repeat(16), ciphertext: "x".repeat(24) };
const at = (nonce: number, issuedAt = 0) => ({
  nonce: `pairing_nonce_${String(nonce).padStart(8, "0")}`,
  issuedAt,
});
const requestAction = {
  action: "request" as const,
  id: "pairing_request_identifier_001",
  targetDeviceId: host.device.deviceId,
  responsePublicKey: "r".repeat(43),
};
const request = (nonce = 1) =>
  signDevicePairingCommand(requester, { ...requestAction, ...at(nonce) });

function fixture() {
  const records = new Map<string, { accountId: string; device: PeerDevice }>(
    [requester, host, other, foreign].map((identity) => [
      identity.device.deviceId,
      { accountId: identity === foreign ? "foreign" : "account", device: identity.device },
    ]),
  );
  const directory = DeviceDirectory.DeviceDirectory.of({
    initialize: Effect.void,
    register: (accountId, device) =>
      Effect.sync(() => void records.set(device.deviceId, { accountId, device })),
    owner: (id) =>
      Effect.sync(() => {
        const record = records.get(id);
        return record
          ? Option.some({ accountId: record.accountId, publicKey: record.device.publicKey })
          : Option.none();
      }),
    list: (accountId) =>
      Effect.sync(() =>
        [...records.values()]
          .filter((record) => record.accountId === accountId)
          .map((record) => record.device),
      ),
    revoke: (accountId, id) =>
      Effect.sync(() => {
        if (records.get(id)?.accountId === accountId) records.delete(id);
      }),
  });
  return {
    records,
    layer: DevicePairing.layer.pipe(
      Layer.provide(
        Layer.merge(NodeCrypto.layer, Layer.succeed(DeviceDirectory.DeviceDirectory, directory)),
      ),
    ),
  };
}

const created = Effect.fn("test.created")(function* (
  service: DevicePairing.DevicePairing["Service"],
) {
  const result = yield* service.execute(request());
  expect("request" in result).toBe(true);
  return (result as { request: DevicePairingRequest }).request;
});

it.effect("delivers an encrypted approval once, only after target approval", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    expect(pairing.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(pairing.proof).toEqual(request());
    expect(
      yield* service.execute(signDevicePairingCommand(host, { action: "pending", ...at(2) })),
    ).toEqual({ requests: [pairing] });
    expect(
      yield* service.execute(
        signDevicePairingCommand(host, { action: "review", code: pairing.code, ...at(3) }),
      ),
    ).toEqual({ request: pairing });
    expect(
      yield* service.execute(
        signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(4) }),
      ),
    ).toEqual({ status: "pending" });
    const approval = signDevicePairingCommand(host, {
      action: "approve",
      id: pairing.id,
      envelope,
      ...at(5),
    });
    expect(yield* service.execute(approval)).toEqual({ ok: true });
    expect(
      yield* service.execute(
        signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(6) }),
      ),
    ).toEqual({ status: "approved", approval });
    expect(
      yield* Effect.flip(
        service.execute(
          signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(7) }),
        ),
      ),
    ).toMatchObject({ code: "not-found" });
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects altered signatures, replayed commands, self and foreign targets", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    expect(
      yield* Effect.flip(service.execute({ ...request(), targetDeviceId: other.device.deviceId })),
    ).toMatchObject({ code: "forbidden" });
    yield* service.execute(request());
    expect(yield* Effect.flip(service.execute(request()))).toMatchObject({ code: "forbidden" });
    for (const targetDeviceId of [requester.device.deviceId, foreign.device.deviceId]) {
      expect(
        yield* Effect.flip(
          service.execute(
            signDevicePairingCommand(requester, {
              ...requestAction,
              targetDeviceId,
              ...at(targetDeviceId === requester.device.deviceId ? 2 : 3),
            }),
          ),
        ),
      ).toMatchObject({ code: "forbidden" });
    }
  }).pipe(Effect.provide(test.layer));
});

it.effect("does not expose requests to other devices or accounts", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    for (const identity of [other, foreign]) {
      expect(
        yield* service.execute(signDevicePairingCommand(identity, { action: "pending", ...at(2) })),
      ).toEqual({ requests: [] });
      expect(
        yield* Effect.flip(
          service.execute(
            signDevicePairingCommand(identity, { action: "review", code: pairing.code, ...at(3) }),
          ),
        ),
      ).toMatchObject({ code: "not-found" });
      expect(
        yield* Effect.flip(
          service.execute(
            signDevicePairingCommand(identity, { action: "check", id: pairing.id, ...at(4) }),
          ),
        ),
      ).toMatchObject({ code: "not-found" });
      expect(
        yield* Effect.flip(
          service.execute(
            signDevicePairingCommand(identity, {
              action: "approve",
              id: pairing.id,
              envelope,
              ...at(5),
            }),
          ),
        ),
      ).toMatchObject({ code: "not-found" });
    }
  }).pipe(Effect.provide(test.layer));
});

it.effect("rechecks the requester registration before releasing an approved grant", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    yield* service.execute(
      signDevicePairingCommand(host, { action: "approve", id: pairing.id, envelope, ...at(2) }),
    );
    test.records.delete(requester.device.deviceId);
    expect(
      yield* Effect.flip(
        service.execute(
          signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(3) }),
        ),
      ),
    ).toMatchObject({ code: "forbidden" });
  }).pipe(Effect.provide(test.layer));
});

it.effect("rechecks the target registration before releasing an approved grant", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    yield* service.execute(
      signDevicePairingCommand(host, { action: "approve", id: pairing.id, envelope, ...at(2) }),
    );
    test.records.delete(host.device.deviceId);
    expect(
      yield* Effect.flip(
        service.execute(
          signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(3) }),
        ),
      ),
    ).toMatchObject({ code: "forbidden" });
  }).pipe(Effect.provide(test.layer));
});

it.effect("expires requests after five minutes", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    yield* TestClock.adjust("301 seconds");
    expect(
      yield* service.execute(
        signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(2, 301) }),
      ),
    ).toEqual({ status: "expired" });
  }).pipe(Effect.provide(test.layer));
});

it.effect("supports explicit denial and requester cancellation", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    yield* service.execute(
      signDevicePairingCommand(host, { action: "deny", code: pairing.code, ...at(2) }),
    );
    expect(
      yield* service.execute(
        signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(3) }),
      ),
    ).toEqual({ status: "denied" });
    const second = yield* service.execute(request(4));
    expect("request" in second).toBe(true);
    yield* service.execute(
      signDevicePairingCommand(requester, { action: "cancel", id: pairing.id, ...at(5) }),
    );
    expect(
      yield* service.execute(signDevicePairingCommand(host, { action: "pending", ...at(6) })),
    ).toEqual({ requests: [] });
    expect(
      yield* service.execute(
        signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(7) }),
      ),
    ).toEqual({ status: "cancelled" });
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps request identity and response key stable on retries", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    expect(yield* service.execute(request(2))).toEqual({ request: pairing });
    const changed = signDevicePairingCommand(requester, {
      ...requestAction,
      responsePublicKey: "z".repeat(43),
      ...at(3),
    });
    expect(yield* Effect.flip(service.execute(changed))).toMatchObject({ code: "conflict" });
    const duplicate = signDevicePairingCommand(requester, {
      ...requestAction,
      id: "pairing_request_identifier_002",
      ...at(4),
    });
    expect(yield* Effect.flip(service.execute(duplicate))).toMatchObject({ code: "conflict" });
  }).pipe(Effect.provide(test.layer));
});

it.effect("caps pending requests per account and releases capacity after expiry", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    for (let index = 0; index < 8; index++) {
      const target = createPeerIdentity(new Uint8Array(32).fill(index + 10), `Host ${index}`);
      test.records.set(target.device.deviceId, { accountId: "account", device: target.device });
      yield* service.execute(
        signDevicePairingCommand(requester, {
          ...requestAction,
          id: `bounded_request_identifier_${index}`,
          targetDeviceId: target.device.deviceId,
          ...at(index + 100),
        }),
      );
    }
    expect(yield* Effect.flip(service.execute(request(120)))).toMatchObject({ code: "limit" });
    yield* TestClock.adjust("301 seconds");
    const result = yield* service.execute(
      signDevicePairingCommand(requester, { ...requestAction, ...at(121, 301) }),
    );
    expect("request" in result).toBe(true);
  }).pipe(Effect.provide(test.layer));
});

it.effect("limits repeated signed operations without retaining the rate limit forever", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    for (let index = 0; index < 60; index++)
      yield* service.execute(
        signDevicePairingCommand(host, { action: "pending", ...at(index + 100) }),
      );
    expect(
      yield* Effect.flip(
        service.execute(signDevicePairingCommand(host, { action: "pending", ...at(200) })),
      ),
    ).toMatchObject({ code: "limit" });
    yield* TestClock.adjust("61 seconds");
    expect(
      yield* service.execute(signDevicePairingCommand(host, { action: "pending", ...at(201, 61) })),
    ).toEqual({ requests: [] });
  }).pipe(Effect.provide(test.layer));
});

it.effect("allows only one concurrent collection of an approved grant", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const service = yield* DevicePairing.DevicePairing;
    const pairing = yield* created(service);
    yield* service.execute(
      signDevicePairingCommand(host, { action: "approve", id: pairing.id, envelope, ...at(2) }),
    );
    const results = yield* Effect.forEach(
      [3, 4],
      (nonce) =>
        Effect.result(
          service.execute(
            signDevicePairingCommand(requester, { action: "check", id: pairing.id, ...at(nonce) }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    expect(results.filter(Result.isFailure)).toHaveLength(1);
    const failed = results.find(Result.isFailure);
    expect(failed?.failure.code).toBe("not-found");
  }).pipe(Effect.provide(test.layer));
});
