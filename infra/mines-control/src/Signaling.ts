import {
  PeerError,
  type PeerDevice,
  type PeerSignal,
  type PeerDeviceDirectory,
} from "@t3tools/contracts/minesPeer";
import { verifyPeerDeviceProof, verifyPeerSignal } from "@t3tools/shared/minesPeerTrust";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as Contacts from "./Contacts.ts";

export interface SignalConnection {
  readonly send: (signal: PeerSignal) => void;
  readonly close: () => void;
}

export class Signaling extends Context.Service<
  Signaling,
  {
    readonly register: (accountId: string, proof: unknown) => Effect.Effect<void, PeerError>;
    readonly devices: (accountId: string) => Effect.Effect<PeerDeviceDirectory, PeerError>;
    readonly ticket: (accountId: string, proof: unknown) => Effect.Effect<string, PeerError>;
    readonly deviceTicket: (proof: unknown) => Effect.Effect<string, PeerError>;
    readonly connect: (
      ticket: string,
      connection: SignalConnection,
    ) => Effect.Effect<
      { readonly accountId: string; readonly device: PeerDevice; readonly disconnect: () => void },
      PeerError
    >;
    readonly forward: (
      accountId: string,
      device: PeerDevice,
      signal: PeerSignal,
    ) => Effect.Effect<void, PeerError>;
    readonly revoke: (accountId: string, deviceId: string) => Effect.Effect<void, PeerError>;
  }
>()("@mines/control/Signaling") {}

const make = Effect.gen(function* () {
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const contacts = yield* Contacts.Contacts;
  const crypto = yield* Crypto.Crypto;
  const registrations = yield* Semaphore.make(1);
  const tickets = new Map<string, { accountId: string; device: PeerDevice; expiresAt: number }>();
  const proofs = new Map<string, number>();
  const connections = new Map<string, { accountId: string; connections: Set<SignalConnection> }>();
  const signalCounts = new Map<string, { count: number; expiresAt: number }>();
  const proof = Effect.fn("Signaling.proof")(function* (
    value: unknown,
    action: "register" | "ticket",
  ) {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const verified = yield* Effect.try({
      try: () => verifyPeerDeviceProof(value, action, now),
      catch: () => new PeerError({ code: "invalid-signature" }),
    });
    for (const [key, expiry] of proofs) if (expiry < now) proofs.delete(key);
    for (const [key, ticket] of tickets) if (ticket.expiresAt < now) tickets.delete(key);
    for (const [key, bucket] of signalCounts) if (bucket.expiresAt < now) signalCounts.delete(key);
    const key = `${verified.device.deviceId}:${verified.nonce}`;
    if (proofs.has(key) || proofs.size >= 10_000)
      return yield* new PeerError({ code: "replayed-signal" });
    proofs.set(key, verified.issuedAt + 61);
    return verified;
  });
  return Signaling.of({
    devices: Effect.fn("Signaling.devices")(function* (accountId) {
      const devices = yield* directory.list(accountId);
      return {
        devices,
        presence: devices.map((device) => ({
          deviceId: device.deviceId,
          online:
            connections.get(device.deviceId)?.accountId === accountId &&
            (connections.get(device.deviceId)?.connections.size ?? 0) > 0,
        })),
      };
    }),
    deviceTicket: Effect.fn("Signaling.deviceTicket")(function* (value) {
      const verified = yield* proof(value, "ticket");
      const owner = yield* directory.owner(verified.device.deviceId);
      if (
        Option.isNone(owner) ||
        owner.value.publicKey !== verified.device.publicKey ||
        tickets.size >= 10_000
      )
        return yield* new PeerError({ code: "unapproved-device" });
      yield* directory.register(owner.value.accountId, verified.device, { existingOnly: true });
      const ticket = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError(() => new PeerError({ code: "direct-unavailable" })));
      tickets.set(ticket, {
        accountId: owner.value.accountId,
        device: verified.device,
        expiresAt: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 30,
      });
      return ticket;
    }),
    register: Effect.fn("Signaling.register")(function* (accountId, value) {
      const verified = yield* proof(value, "register");
      const devices = yield* directory.list(accountId);
      if (
        devices.length >= 20 &&
        !devices.some((entry) => entry.deviceId === verified.device.deviceId)
      )
        return yield* new PeerError({ code: "unapproved-device" });
      yield* directory.register(accountId, verified.device);
    }, registrations.withPermit),
    ticket: Effect.fn("Signaling.ticket")(function* (accountId, value) {
      const verified = yield* proof(value, "ticket");
      const devices = yield* directory.list(accountId);
      const device = devices.find(
        (entry) =>
          entry.deviceId === verified.device.deviceId &&
          entry.publicKey === verified.device.publicKey,
      );
      if (!device || tickets.size >= 10_000)
        return yield* new PeerError({ code: "unapproved-device" });
      const ticket = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError(() => new PeerError({ code: "direct-unavailable" })));
      tickets.set(ticket, {
        accountId,
        device,
        expiresAt: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 30,
      });
      return ticket;
    }),
    connect: Effect.fn("Signaling.connect")(function* (token, connection) {
      const ticket = tickets.get(token);
      tickets.delete(token);
      if (!ticket || ticket.expiresAt < Math.floor((yield* Clock.currentTimeMillis) / 1000))
        return yield* new PeerError({ code: "unapproved-device" });
      const current = (yield* directory.list(ticket.accountId)).find(
        (device) => device.deviceId === ticket.device.deviceId,
      );
      if (!current) return yield* new PeerError({ code: "unapproved-device" });
      const active = connections.get(current.deviceId) ?? {
        accountId: ticket.accountId,
        connections: new Set<SignalConnection>(),
      };
      if (active.accountId !== ticket.accountId || active.connections.size >= 8)
        return yield* new PeerError({ code: "direct-unavailable" });
      active.connections.add(connection);
      connections.set(current.deviceId, active);
      return {
        accountId: ticket.accountId,
        device: current,
        disconnect: () => {
          active.connections.delete(connection);
          if (active.connections.size === 0 && connections.get(current.deviceId) === active)
            connections.delete(current.deviceId);
        },
      };
    }),
    forward: Effect.fn("Signaling.forward")(function* (accountId, device, signal) {
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const verified = yield* Effect.try({
        try: () => verifyPeerSignal(signal, device, signal.toDeviceId, now),
        catch: () => new PeerError({ code: "invalid-signature" }),
      });
      const count = signalCounts.get(device.deviceId);
      const bucket = !count || count.expiresAt < now ? { count: 0, expiresAt: now + 60 } : count;
      if (++bucket.count > 30) return yield* new PeerError({ code: "direct-unavailable" });
      signalCounts.set(device.deviceId, bucket);
      let targetAccountId = accountId;
      if (verified.sharedGroupKey) {
        const fromOwner = yield* directory.owner(device.deviceId);
        const toOwner = yield* directory.owner(verified.toDeviceId);
        if (
          Option.isNone(fromOwner) ||
          Option.isNone(toOwner) ||
          fromOwner.value.accountId !== accountId ||
          fromOwner.value.publicKey !== device.publicKey
        )
          return yield* new PeerError({ code: "unapproved-device" });
        const grant = yield* contacts
          .groupAccess(accountId, {
            groupKey: verified.sharedGroupKey,
            fromDeviceId: device.deviceId,
            toDeviceId: verified.toDeviceId,
          })
          .pipe(Effect.mapError(() => new PeerError({ code: "unapproved-device" })));
        if (
          grant.groupKey !== verified.sharedGroupKey ||
          grant.from.deviceId !== device.deviceId ||
          grant.from.publicKey !== device.publicKey ||
          grant.to.deviceId !== verified.toDeviceId ||
          grant.to.publicKey !== toOwner.value.publicKey
        )
          return yield* new PeerError({ code: "unapproved-device" });
        targetAccountId = toOwner.value.accountId;
      } else {
        const devices = yield* directory.list(accountId);
        if (
          !devices.some(
            (entry) => entry.deviceId === device.deviceId && entry.publicKey === device.publicKey,
          ) ||
          !devices.some((entry) => entry.deviceId === verified.toDeviceId)
        )
          return yield* new PeerError({ code: "unapproved-device" });
      }
      const target = connections.get(verified.toDeviceId);
      if (!target || target.accountId !== targetAccountId)
        return yield* new PeerError({ code: "direct-unavailable" });
      for (const connection of target.connections) connection.send(verified);
    }),
    revoke: Effect.fn("Signaling.revoke")(function* (accountId, deviceId) {
      yield* directory.revoke(accountId, deviceId);
      const active = connections.get(deviceId);
      if (active?.accountId === accountId) {
        for (const connection of active.connections) connection.close();
        connections.delete(deviceId);
      }
      for (const [token, ticket] of tickets)
        if (ticket.accountId === accountId && ticket.device.deviceId === deviceId)
          tickets.delete(token);
    }),
  });
});

export const layer = Layer.effect(Signaling, make);
