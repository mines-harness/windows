import {
  DevicePairingCommand,
  DevicePairingError,
  type DevicePairingApproveCommand,
  type DevicePairingRequest,
  type DevicePairingResult,
} from "@t3tools/contracts/minesDevicePairing";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import { verifyDevicePairingCommand } from "@t3tools/shared/minesDevicePairing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DeviceDirectory from "./DeviceDirectory.ts";

export class DevicePairing extends Context.Service<
  DevicePairing,
  { readonly execute: (value: unknown) => Effect.Effect<DevicePairingResult, DevicePairingError> }
>()("@mines/control/DevicePairing") {}

interface PendingRequest {
  readonly accountId: string;
  readonly request: DevicePairingRequest;
  readonly expiresAt: number;
  status: "pending" | "approved" | "denied" | "cancelled";
  approval?: DevicePairingApproveCommand;
}

const decodeCommand = Schema.decodeUnknownSync(DevicePairingCommand);
const isPairingError = Schema.is(DevicePairingError);
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const make = Effect.gen(function* () {
  const directory = yield* DeviceDirectory.DeviceDirectory;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const requests = new Map<string, PendingRequest>();
  const proofs = new Map<string, number>();
  const rates = new Map<string, { expiresAt: number; count: number }>();
  const knownDevices = Effect.fn("DevicePairing.knownDevices")(function* (device: PeerDevice) {
    const owner = yield* directory
      .owner(device.deviceId)
      .pipe(Effect.mapError(() => new DevicePairingError({ code: "unavailable" })));
    if (Option.isNone(owner) || owner.value.publicKey !== device.publicKey)
      return yield* new DevicePairingError({ code: "forbidden" });
    const devices = yield* directory
      .list(owner.value.accountId)
      .pipe(Effect.mapError(() => new DevicePairingError({ code: "unavailable" })));
    if (
      !devices.some(
        (current) => current.deviceId === device.deviceId && current.publicKey === device.publicKey,
      )
    )
      return yield* new DevicePairingError({ code: "forbidden" });
    return { accountId: owner.value.accountId, devices };
  });
  const code = Effect.fn("DevicePairing.code")(function* () {
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = yield* crypto
        .randomBytes(8)
        .pipe(Effect.mapError(() => new DevicePairingError({ code: "unavailable" })));
      const value = [...bytes].map((byte) => alphabet[byte & 31]).join("");
      if (![...requests.values()].some((entry) => entry.request.code === value)) return value;
    }
    return yield* new DevicePairingError({ code: "limit" });
  });
  const execute = Effect.fn("DevicePairing.execute")(function* (
    value: unknown,
  ): Effect.fn.Return<DevicePairingResult, DevicePairingError> {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const command = yield* Effect.try({
      try: () => decodeCommand(verifyDevicePairingCommand(value, now)),
      catch: (error) =>
        isPairingError(error) ? error : new DevicePairingError({ code: "invalid-input" }),
    });
    const actor = yield* knownDevices(command.device);
    for (const [id, entry] of requests) {
      const selected =
        ("id" in command && command.id === id) ||
        ("code" in command && command.code === entry.request.code);
      if (entry.expiresAt <= now && !selected) requests.delete(id);
    }
    for (const [nonce, expiry] of proofs) if (expiry <= now) proofs.delete(nonce);
    for (const [deviceId, rate] of rates) if (rate.expiresAt <= now) rates.delete(deviceId);
    const nonce = `${command.device.deviceId}:${command.nonce}`;
    if (proofs.has(nonce)) return yield* new DevicePairingError({ code: "forbidden" });
    if (proofs.size >= 10_000) return yield* new DevicePairingError({ code: "limit" });
    const rate = rates.get(command.device.deviceId) ?? { expiresAt: now + 60, count: 0 };
    if (++rate.count > 60) return yield* new DevicePairingError({ code: "limit" });
    rates.set(command.device.deviceId, rate);
    proofs.set(nonce, command.issuedAt + 61);
    const current = (device: PeerDevice) =>
      actor.devices.some(
        (entry) => entry.deviceId === device.deviceId && entry.publicKey === device.publicKey,
      );
    const active = (entry: PendingRequest) =>
      entry.accountId === actor.accountId &&
      current(entry.request.requester) &&
      current(entry.request.target);
    if (command.action === "request") {
      const target = actor.devices.find((entry) => entry.deviceId === command.targetDeviceId);
      if (!target || target.deviceId === command.device.deviceId)
        return yield* new DevicePairingError({ code: "forbidden" });
      const previous = requests.get(command.id);
      if (previous) {
        if (
          previous.status === "pending" &&
          active(previous) &&
          previous.request.requester.deviceId === command.device.deviceId &&
          previous.request.target.deviceId === target.deviceId &&
          previous.request.responsePublicKey === command.responsePublicKey &&
          previous.expiresAt > now
        )
          return { request: previous.request };
        return yield* new DevicePairingError({ code: "conflict" });
      }
      const accountRequests = [...requests.values()].filter(
        (entry) =>
          entry.accountId === actor.accountId &&
          (entry.status === "pending" || entry.status === "approved"),
      );
      if (requests.size >= 256 || accountRequests.length >= 8)
        return yield* new DevicePairingError({ code: "limit" });
      if (
        accountRequests.some(
          (entry) =>
            entry.status === "pending" &&
            entry.request.requester.deviceId === command.device.deviceId &&
            entry.request.target.deviceId === target.deviceId,
        )
      )
        return yield* new DevicePairingError({ code: "conflict" });
      const expiresAt = Math.min(now + 300, command.issuedAt + 300);
      const request: DevicePairingRequest = {
        id: command.id,
        code: yield* code(),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt * 1000)),
        requester: command.device,
        target,
        responsePublicKey: command.responsePublicKey,
        proof: command,
      };
      requests.set(command.id, {
        accountId: actor.accountId,
        request,
        expiresAt,
        status: "pending",
      });
      return { request };
    }
    if (command.action === "pending") {
      return {
        requests: [...requests.values()]
          .filter(
            (entry) =>
              entry.status === "pending" &&
              entry.expiresAt > now &&
              entry.request.target.deviceId === command.device.deviceId &&
              active(entry),
          )
          .map((entry) => entry.request),
      };
    }
    const entry =
      "id" in command
        ? requests.get(command.id)
        : [...requests.values()].find((item) => item.request.code === command.code);
    const requester = command.action === "check" || command.action === "cancel";
    if (
      !entry ||
      entry.accountId !== actor.accountId ||
      (requester ? entry.request.requester : entry.request.target).deviceId !==
        command.device.deviceId
    )
      return yield* new DevicePairingError({ code: "not-found" });
    if (!active(entry)) {
      requests.delete(entry.request.id);
      return yield* new DevicePairingError({ code: "forbidden" });
    }
    if (entry.expiresAt <= now) {
      requests.delete(entry.request.id);
      if (command.action === "check") return { status: "expired" };
      return yield* new DevicePairingError({ code: "expired" });
    }
    if (command.action === "check") {
      if (entry.status === "approved") {
        if (!entry.approval) return yield* new DevicePairingError({ code: "unavailable" });
        requests.delete(entry.request.id);
        return { status: "approved", approval: entry.approval };
      }
      if (entry.status === "pending") return { status: "pending" };
      requests.delete(entry.request.id);
      return { status: entry.status };
    }
    if (command.action === "cancel") {
      entry.status = "cancelled";
      delete entry.approval;
      return { ok: true };
    }
    if (entry.status !== "pending") return yield* new DevicePairingError({ code: "conflict" });
    if (command.action === "review") return { request: entry.request };
    if (command.action === "deny") {
      entry.status = "denied";
      return { ok: true };
    }
    entry.status = "approved";
    entry.approval = command;
    return { ok: true };
  }, lock.withPermit);
  return DevicePairing.of({ execute });
});

export const layer = Layer.effect(DevicePairing, make);
