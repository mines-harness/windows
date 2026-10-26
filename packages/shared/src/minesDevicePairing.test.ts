import { describe, expect, it } from "@effect/vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { EnvironmentId } from "@t3tools/contracts";
import {
  DevicePairingCommand,
  type DevicePairingApproveCommand,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import {
  beginDevicePairing,
  cancelDevicePairing,
  collectDevicePairing,
  completeDevicePairing,
  denyDevicePairing,
  listDevicePairings,
  reviewDevicePairing,
  signDevicePairingCommand,
  verifyDevicePairingCommand,
  type DevicePairingContext,
} from "./minesDevicePairing.ts";
import { encodePeerPairing } from "./minesPeerPairing.ts";
import { createPeerIdentity } from "./minesPeerTrust.ts";
import { stableStringify } from "./relaySigning.ts";

const first = createPeerIdentity(new Uint8Array(32).fill(1), "MacBook");
const second = createPeerIdentity(new Uint8Array(32).fill(2), "OVH");
const other = createPeerIdentity(new Uint8Array(32).fill(3), "Another computer");
const decodeCommand = Schema.decodeUnknownSync(DevicePairingCommand);
const decodeLegacyCommand = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    action: Schema.Literal("pending"),
    nonce: Schema.String,
    issuedAt: Schema.Number,
    signature: Schema.String,
    device: Schema.Struct({
      deviceId: Schema.String,
      publicKey: Schema.String,
      label: Schema.String,
    }),
  }),
);

function setup() {
  let counter = 0;
  let request: DevicePairingRequest | undefined;
  let approval: DevicePairingApproveCommand | undefined;
  let status: "pending" | "denied" | "cancelled" = "pending";
  const actions: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/devices") return Response.json({ accountId: "test-account" });
    const command = verifyDevicePairingCommand(JSON.parse(String(init?.body)), 0);
    actions.push(command.action);
    switch (command.action) {
      case "request":
        request = {
          id: command.id,
          code: "ABCDEFGH",
          expiresAt: "1970-01-01T00:05:00.000Z",
          requester: command.device,
          target: second.device,
          responsePublicKey: command.responsePublicKey,
          proof: command,
        };
        return Response.json({ request });
      case "pending":
        return Response.json({ requests: request ? [request] : [] });
      case "review":
        expect(command.code).toBe("ABCDEFGH");
        return Response.json({ request });
      case "approve":
        approval = command;
        return Response.json({ ok: true });
      case "check":
        return Response.json(approval ? { status: "approved", approval } : { status });
      case "cancel":
        status = "cancelled";
        return Response.json({ ok: true });
      case "deny":
        status = "denied";
        return Response.json({ ok: true });
    }
  };
  const context = (identity = first): DevicePairingContext => ({
    controlUrl: "https://mines.example.test",
    identity,
    randomId: () => `pairing_identifier_${++counter}`,
    nowSeconds: () => 0,
    fetch: fetcher,
  });
  const begin = () =>
    beginDevicePairing({
      ...context(),
      targetDeviceId: second.device.deviceId,
      bearerToken: async () => "fixture-bearer",
    });
  const pairingUrl = encodePeerPairing({
    version: 1,
    host: second.device,
    controlUrl: "https://mines.example.test",
    stunServers: ["stun:mines.example.test:3478"],
    environmentId: EnvironmentId.make("pairing-environment"),
    pairingToken: "private-one-time-workspace-grant",
    expiresAt: "1970-01-01T00:05:00.000Z",
  });
  return { actions, context, begin, pairingUrl, getApproval: () => approval };
}

describe("device pairing proofs", () => {
  it("keeps pairing signatures verifiable by clients that strip platform metadata", () => {
    const identity = createPeerIdentity(first.privateKey, first.device.label, "macos");
    const command = signDevicePairingCommand(identity, {
      action: "pending",
      nonce: "legacy_nonce_00001",
      issuedAt: 10,
    });
    const legacy = decodeLegacyCommand(command);
    const { signature, ...unsigned } = legacy;
    expect(
      ed25519.verify(
        Result.getOrThrow(Base64Url.decode(signature)),
        new TextEncoder().encode(stableStringify(unsigned)),
        Result.getOrThrow(Base64Url.decode(legacy.device.publicKey)),
      ),
    ).toBe(true);
    expect(verifyDevicePairingCommand(command, 10)).toEqual(command);
  });

  it("binds the exact operation, target, response key and request to the device signature", () => {
    const command = signDevicePairingCommand(first, {
      action: "request",
      id: "request_identifier_001",
      targetDeviceId: second.device.deviceId,
      responsePublicKey: "a".repeat(43),
      nonce: "nonce_identifier_001",
      issuedAt: 10,
    });
    expect(verifyDevicePairingCommand(command, 10)).toEqual(command);
    expect(() =>
      verifyDevicePairingCommand({ ...command, targetDeviceId: other.device.deviceId }, 10),
    ).toThrow();
    expect(() => verifyDevicePairingCommand({ ...command, action: "cancel" }, 10)).toThrow();
    expect(() =>
      verifyDevicePairingCommand({ ...command, responsePublicKey: "b".repeat(43) }, 10),
    ).toThrow();
    expect(() => verifyDevicePairingCommand(command, 100)).toThrow();
  });
});

describe("device pairing exchange", () => {
  it("delivers the existing workspace grant only through a verified encrypted host approval", async () => {
    const test = setup();
    const pairing = await test.begin();
    expect(await collectDevicePairing({ ...test.context(), pairing })).toEqual({
      status: "pending",
    });
    const requests = await listDevicePairings(test.context(second));
    expect(requests).toEqual([pairing.request]);
    const reviewed = await reviewDevicePairing({ ...test.context(second), code: "abcd-efgh" });
    await completeDevicePairing({
      ...test.context(second),
      request: reviewed,
      pairingUrl: test.pairingUrl,
    });
    const approval = test.getApproval();
    expect(approval).toBeDefined();
    expect(JSON.stringify(approval)).not.toContain("private-one-time-workspace-grant");
    expect(await collectDevicePairing({ ...test.context(), pairing })).toEqual({
      status: "approved",
      pairingUrl: test.pairingUrl,
    });
    expect([...pairing.privateKey]).toEqual(Array(32).fill(0));
    expect(test.actions).toEqual(["request", "check", "pending", "review", "approve", "check"]);
  });

  it("does not allow another local identity or another host to consume or approve the request", async () => {
    const test = setup();
    const pairing = await test.begin();
    await expect(collectDevicePairing({ ...test.context(other), pairing })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      completeDevicePairing({
        ...test.context(other),
        request: pairing.request,
        pairingUrl: test.pairingUrl,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(listDevicePairings(test.context(other))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("rejects a broker that modifies the signed encrypted grant", async () => {
    const test = setup();
    const pairing = await test.begin();
    await completeDevicePairing({
      ...test.context(second),
      request: pairing.request,
      pairingUrl: test.pairingUrl,
    });
    const approved = test.getApproval()!;
    const tampered = decodeCommand({
      ...approved,
      envelope: {
        ...approved.envelope,
        ciphertext: "a".repeat(approved.envelope.ciphertext.length),
      },
    });
    await expect(
      collectDevicePairing({
        ...test.context(),
        fetch: async () => Response.json({ status: "approved", approval: tampered }),
        pairing,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("supports denial and cancellation without returning a workspace grant", async () => {
    const test = setup();
    const pairing = await test.begin();
    await denyDevicePairing({ ...test.context(second), code: pairing.request.code });
    expect(await collectDevicePairing({ ...test.context(), pairing })).toEqual({
      status: "denied",
    });
    const cancelled = await test.begin();
    await cancelDevicePairing({ ...test.context(), pairing: cancelled });
    expect([...cancelled.privateKey]).toEqual(Array(32).fill(0));
    expect(test.actions).toContain("cancel");
  });
});
