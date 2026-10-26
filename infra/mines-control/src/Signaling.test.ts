import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { PeerError, type PeerDevice, type PeerSignal } from "@t3tools/contracts/minesPeer";
import { ContactsError, SharedGroupDeviceGrant } from "@t3tools/contracts/contacts";
import {
  createPeerIdentity,
  signPeerDeviceProof,
  signPeerSignal,
} from "@t3tools/shared/minesPeerTrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as Signaling from "./Signaling.ts";
import * as Contacts from "./Contacts.ts";

const decodeGrant = Schema.decodeUnknownSync(SharedGroupDeviceGrant);

function service(
  groupAccess: Contacts.Contacts["Service"]["groupAccess"] = () =>
    Effect.fail(new ContactsError({ code: "forbidden" })),
) {
  const devices = new Map<string, { accountId: string; device: PeerDevice }>();
  const directory = DeviceDirectory.DeviceDirectory.of({
    initialize: Effect.void,
    register: (accountId, device) =>
      Effect.sync(() => {
        devices.set(device.deviceId, { accountId, device });
      }),
    owner: (id) =>
      Effect.sync(() => {
        const value = devices.get(id);
        return value
          ? Option.some({ accountId: value.accountId, publicKey: value.device.publicKey })
          : Option.none();
      }),
    list: (accountId) =>
      Effect.sync(() =>
        [...devices.values()]
          .filter((entry) => entry.accountId === accountId)
          .map((entry) => entry.device),
      ),
    revoke: (accountId, id) =>
      Effect.sync(() => {
        if (devices.get(id)?.accountId === accountId) devices.delete(id);
      }),
  });
  return Signaling.Signaling.pipe(
    Effect.provide(
      Signaling.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            Layer.succeed(DeviceDirectory.DeviceDirectory, directory),
            Layer.mock(Contacts.Contacts)({ groupAccess }),
          ),
        ),
      ),
    ),
  );
}

const first = createPeerIdentity(new Uint8Array(32).fill(1), "Host");
const second = createPeerIdentity(new Uint8Array(32).fill(2), "Phone");
const third = createPeerIdentity(new Uint8Array(32).fill(3), "Other account");
const connection = () => {
  const received: PeerSignal[] = [];
  let closed = false;
  return {
    received,
    close: () => {
      closed = true;
    },
    send: (signal: PeerSignal) => received.push(signal),
    isClosed: () => closed,
  };
};
const description = {
  type: "offer" as const,
  sdp: `v=0\r\na=fingerprint:sha-256 ${Array(32).fill("AB").join(":")}\r\na=candidate:1 1 UDP 1 127.0.0.1 12345 typ host\r\n`,
};

it.effect(
  "refreshes only an active device's self-signed name and platform when issuing a device ticket",
  () => {
    const renamed = {
      ...first,
      device: { ...first.device, label: "OVH server", platform: "linux" as const },
    };
    let stored = first.device;
    const directory = Layer.mock(DeviceDirectory.DeviceDirectory, {
      owner: () => Effect.succeedSome({ accountId: "account", publicKey: first.device.publicKey }),
      list: () => Effect.succeed([stored]),
      register: (accountId, device, options) =>
        Effect.sync(() => {
          expect(accountId).toBe("account");
          expect(options).toEqual({ existingOnly: true });
          stored = device;
        }),
    });
    return Effect.gen(function* () {
      const signaling = yield* Signaling.Signaling;
      const ticket = yield* signaling.deviceTicket(
        signPeerDeviceProof(renamed, "ticket", "rename_nonce_identifier", 0),
      );
      const opened = yield* signaling.connect(ticket, connection());
      expect(opened.device.label).toBe("OVH server");
      expect(opened.device.platform).toBe("linux");
      expect(opened.device.deviceId).toBe(first.device.deviceId);
      expect(opened.device.publicKey).toBe(first.device.publicKey);
    }).pipe(
      Effect.provide(
        Signaling.layer.pipe(
          Layer.provide(
            Layer.mergeAll(NodeCrypto.layer, directory, Layer.mock(Contacts.Contacts, {})),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "does not reactivate a device revoked between ownership lookup and metadata refresh",
  () => {
    let revoked = false;
    const directory = Layer.mock(DeviceDirectory.DeviceDirectory, {
      owner: () =>
        Effect.sync(() => {
          revoked = true;
          return Option.some({ accountId: "account", publicKey: first.device.publicKey });
        }),
      register: (_accountId, _device, options) =>
        Effect.suspend(() => {
          if (!options?.existingOnly) revoked = false;
          return revoked ? Effect.fail(new PeerError({ code: "unapproved-device" })) : Effect.void;
        }),
    });
    return Effect.gen(function* () {
      const signaling = yield* Signaling.Signaling;
      expect(
        yield* Effect.flip(
          signaling.deviceTicket(
            signPeerDeviceProof(first, "ticket", "revocation_nonce_identifier", 0),
          ),
        ),
      ).toMatchObject({ code: "unapproved-device" });
      expect(revoked).toBe(true);
    }).pipe(
      Effect.provide(
        Signaling.layer.pipe(
          Layer.provide(
            Layer.mergeAll(NodeCrypto.layer, directory, Layer.mock(Contacts.Contacts, {})),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "routes group-scoped cross-account signaling only while its invitation stays accepted",
  () =>
    Effect.gen(function* () {
      let accepted = true;
      const groupKey = "shared_group_0123456789";
      const devices = [first.device, third.device];
      const signaling = yield* service((accountId, input) => {
        const from = devices.find((device) => device.deviceId === input.fromDeviceId);
        const to = devices.find((device) => device.deviceId === input.toDeviceId);
        if (!accepted || input.groupKey !== groupKey || !from || !to)
          return Effect.fail(new ContactsError({ code: "forbidden" }));
        expect(accountId).toBe(from === first.device ? "account" : "other");
        return Effect.succeed(
          decodeGrant({
            groupKey,
            groupId: "shared-group",
            coordinatorEnvironmentId: "environment",
            coordinatorDevice: first.device,
            from,
            to,
            fromFriendId: "mines-11111111111111111111",
            toFriendId: "mines-22222222222222222222",
            updatedAt: "2026-10-26T00:00:00.000Z",
          }),
        );
      });
      for (const [identity, account] of [
        [first, "account"],
        [third, "other"],
      ] as const)
        yield* signaling.register(
          account,
          signPeerDeviceProof(identity, "register", "registration_nonce_001", 0),
        );
      const recipient = connection();
      const ticket = yield* signaling.deviceTicket(
        signPeerDeviceProof(third, "ticket", "ticket_nonce_00001", 0),
      );
      yield* signaling.connect(ticket, recipient);
      const signal = signPeerSignal(first, {
        sessionId: "session_identifier_001",
        sharedGroupKey: groupKey,
        toDeviceId: third.device.deviceId,
        issuedAt: 0,
        description,
      });
      yield* signaling.forward("account", first.device, signal);
      expect(recipient.received).toEqual([signal]);
      accepted = false;
      expect(yield* Effect.flip(signaling.forward("account", first.device, signal))).toMatchObject({
        code: "unapproved-device",
      });
      expect(recipient.received).toHaveLength(1);
      const privateSignal = signPeerSignal(first, {
        sessionId: "session_identifier_002",
        toDeviceId: third.device.deviceId,
        issuedAt: 0,
        description,
      });
      expect(
        yield* Effect.flip(signaling.forward("account", first.device, privateSignal)),
      ).toMatchObject({ code: "unapproved-device" });
    }),
);

it.effect("does not route a denied shared group through the same-account private path", () =>
  Effect.gen(function* () {
    const signaling = yield* service();
    for (const identity of [first, second])
      yield* signaling.register(
        "account",
        signPeerDeviceProof(identity, "register", "registration_nonce_001", 0),
      );
    const recipient = connection();
    const ticket = yield* signaling.deviceTicket(
      signPeerDeviceProof(second, "ticket", "ticket_nonce_00001", 0),
    );
    yield* signaling.connect(ticket, recipient);
    const signal = signPeerSignal(first, {
      sessionId: "session_identifier_001",
      sharedGroupKey: "shared_group_0123456789",
      toDeviceId: second.device.deviceId,
      issuedAt: 0,
      description,
    });
    expect(yield* Effect.flip(signaling.forward("account", first.device, signal))).toMatchObject({
      code: "unapproved-device",
    });
    expect(recipient.received).toEqual([]);
  }),
);

it.effect(
  "issues device-bound tickets without retaining an account session and rejects reuse",
  () =>
    Effect.gen(function* () {
      const signaling = yield* service();
      yield* signaling.register(
        "account",
        signPeerDeviceProof(first, "register", "registration_nonce_001", 0),
      );
      const proof = signPeerDeviceProof(first, "ticket", "ticket_nonce_00001", 0);
      const ticket = yield* signaling.deviceTicket(proof);
      expect(yield* Effect.flip(signaling.deviceTicket(proof))).toMatchObject({
        code: "replayed-signal",
      });
      const opened = yield* signaling.connect(ticket, connection());
      expect(opened.device).toEqual(first.device);
      expect(opened.accountId).toBe("account");
      expect(yield* Effect.flip(signaling.connect(ticket, connection()))).toMatchObject({
        code: "unapproved-device",
      });
      const next = yield* signaling.deviceTicket(
        signPeerDeviceProof(first, "ticket", "ticket_nonce_00002", 0),
      );
      yield* TestClock.adjust("31 seconds");
      expect(yield* Effect.flip(signaling.connect(next, connection()))).toMatchObject({
        code: "unapproved-device",
      });
    }),
);

it.effect("routes signed SDP only inside the registered account and revokes active presence", () =>
  Effect.gen(function* () {
    const signaling = yield* service();
    for (const [identity, account] of [
      [first, "account"],
      [second, "account"],
      [third, "other"],
    ] as const) {
      yield* signaling.register(
        account,
        signPeerDeviceProof(identity, "register", "registration_nonce_001", 0),
      );
    }
    const phone = connection();
    const ticket = yield* signaling.deviceTicket(
      signPeerDeviceProof(second, "ticket", "ticket_nonce_00001", 0),
    );
    yield* signaling.connect(ticket, phone);
    const signal = signPeerSignal(first, {
      sessionId: "session_identifier_001",
      toDeviceId: second.device.deviceId,
      issuedAt: 0,
      description,
    });
    yield* signaling.forward("account", first.device, signal);
    expect(phone.received).toEqual([signal]);
    const wrong = signPeerSignal(third, {
      sessionId: "session_identifier_002",
      toDeviceId: second.device.deviceId,
      issuedAt: 0,
      description,
    });
    expect(yield* Effect.flip(signaling.forward("other", third.device, wrong))).toMatchObject({
      code: "unapproved-device",
    });
    yield* signaling.revoke("account", second.device.deviceId);
    expect(phone.isClosed()).toBe(true);
    expect(
      yield* Effect.flip(
        signaling.deviceTicket(signPeerDeviceProof(second, "ticket", "ticket_nonce_00002", 0)),
      ),
    ).toMatchObject({ code: "unapproved-device" });
  }),
);

it.effect("rejects an unregistered key and tampered proofs", () =>
  Effect.gen(function* () {
    const signaling = yield* service();
    const proof = signPeerDeviceProof(first, "ticket", "ticket_nonce_00001", 0);
    expect(yield* Effect.flip(signaling.deviceTicket(proof))).toMatchObject({
      code: "unapproved-device",
    });
    const result = yield* Effect.flip(signaling.deviceTicket({ ...proof, device: second.device }));
    expect(result).toEqual(new PeerError({ code: "invalid-signature" }));
  }),
);

it.effect("keeps concurrent device negotiations connected and revokes every presence", () =>
  Effect.gen(function* () {
    const signaling = yield* service();
    for (const identity of [first, second])
      yield* signaling.register(
        "account",
        signPeerDeviceProof(identity, "register", "registration_nonce_001", 0),
      );
    const connections = [connection(), connection()];
    for (const [index, current] of connections.entries()) {
      const ticket = yield* signaling.deviceTicket(
        signPeerDeviceProof(second, "ticket", `ticket_nonce_0000${index}`, 0),
      );
      yield* signaling.connect(ticket, current);
    }
    expect(connections.every((current) => !current.isClosed())).toBe(true);
    const signal = signPeerSignal(first, {
      sessionId: "session_identifier_001",
      toDeviceId: second.device.deviceId,
      issuedAt: 0,
      description,
    });
    yield* signaling.forward("account", first.device, signal);
    expect(connections.map((current) => current.received)).toEqual([[signal], [signal]]);
    yield* signaling.revoke("account", second.device.deviceId);
    expect(connections.every((current) => current.isClosed())).toBe(true);
  }),
);

it.effect(
  "lists only the account's devices and reports signaling presence until every connection closes",
  () =>
    Effect.gen(function* () {
      const signaling = yield* service();
      for (const [identity, account] of [
        [first, "account"],
        [second, "account"],
        [third, "other"],
      ] as const)
        yield* signaling.register(
          account,
          signPeerDeviceProof(identity, "register", "registration_nonce_001", 0),
        );
      expect(yield* signaling.devices("account")).toEqual({
        devices: [first.device, second.device],
        presence: [
          { deviceId: first.device.deviceId, online: false },
          { deviceId: second.device.deviceId, online: false },
        ],
      });
      const opened = [];
      for (const index of [1, 2]) {
        const ticket = yield* signaling.deviceTicket(
          signPeerDeviceProof(second, "ticket", `presence_nonce_000${index}`, 0),
        );
        opened.push(yield* signaling.connect(ticket, connection()));
      }
      expect((yield* signaling.devices("account")).presence[1]?.online).toBe(true);
      opened[0]!.disconnect();
      expect((yield* signaling.devices("account")).presence[1]?.online).toBe(true);
      opened[1]!.disconnect();
      expect((yield* signaling.devices("account")).presence[1]?.online).toBe(false);
      yield* signaling.revoke("account", second.device.deviceId);
      expect((yield* signaling.devices("account")).devices).toEqual([first.device]);
      expect((yield* signaling.devices("other")).devices).toEqual([third.device]);
    }),
);
