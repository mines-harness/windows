import { describe, expect, it } from "@effect/vitest";

import {
  createPeerIdentity,
  signPeerDeviceProof,
  verifyPeerDeviceProof,
  signPeerSignal,
  verifyPeerSignal,
  validateDirectDescription,
  validateStunServers,
} from "./minesPeerTrust.ts";

const sdp =
  "v=0\r\na=fingerprint:sha-256 " +
  Array(32).fill("AB").join(":") +
  "\r\na=candidate:1 1 UDP 1 192.168.1.2 5000 typ host\r\n";

describe("direct peer trust", () => {
  it("signs device platform metadata without changing an existing identity", () => {
    const key = new Uint8Array(32).fill(17);
    const legacy = createPeerIdentity(key, "My Pixel");
    const identity = createPeerIdentity(key, "My Pixel", "android");
    expect(identity.device.platform).toBe("android");
    expect(identity.device.deviceId).toBe(legacy.device.deviceId);
    expect(identity.device.publicKey).toBe(legacy.device.publicKey);
    const proof = signPeerDeviceProof(identity, "register", "metadata_nonce_001", 1000);
    expect(verifyPeerDeviceProof(proof, "register", 1001).device).toEqual(identity.device);
    expect(() =>
      verifyPeerDeviceProof(
        { ...proof, device: { ...proof.device, platform: "ios" } },
        "register",
        1001,
      ),
    ).toThrow();
    expect(
      verifyPeerDeviceProof(
        signPeerDeviceProof(legacy, "register", "legacy_nonce_00001", 1000),
        "register",
        1001,
      ).device,
    ).toEqual(legacy.device);
  });

  it("binds shared-group negotiation to its group and rejects a private downgrade", () => {
    const sender = createPeerIdentity(new Uint8Array(32).fill(1), "Mac");
    const recipient = createPeerIdentity(new Uint8Array(32).fill(2), "Phone");
    const signal = signPeerSignal(sender, {
      sessionId: "session_test_0123456789",
      sharedGroupKey: "shared_group_0123456789",
      toDeviceId: recipient.device.deviceId,
      issuedAt: 1000,
      description: { type: "offer", sdp },
    });
    expect(verifyPeerSignal(signal, sender.device, recipient.device.deviceId, 1001)).toEqual(
      signal,
    );
    const { sharedGroupKey: _groupKey, ...privateSignal } = signal;
    for (const tampered of [
      privateSignal,
      { ...signal, sharedGroupKey: "different_group_0123456789" },
    ])
      expect(() =>
        verifyPeerSignal(tampered, sender.device, recipient.device.deviceId, 1001),
      ).toThrow();
  });

  it("binds negotiation to an approved device, recipient and session", () => {
    const sender = createPeerIdentity(new Uint8Array(32).fill(1), "Mac");
    const recipient = createPeerIdentity(new Uint8Array(32).fill(2), "Phone");
    const signal = signPeerSignal(sender, {
      sessionId: "session_test_0123456789",
      toDeviceId: recipient.device.deviceId,
      issuedAt: 1000,
      description: { type: "offer", sdp },
    });
    expect(verifyPeerSignal(signal, sender.device, recipient.device.deviceId, 1001)).toBeTruthy();
    expect(() =>
      verifyPeerSignal(
        {
          ...signal,
          description: { type: "offer", sdp: sdp.replace("192.168.1.2", "192.168.1.3") },
        },
        sender.device,
        recipient.device.deviceId,
        1001,
      ),
    ).toThrow();
    expect(() =>
      verifyPeerSignal(signal, recipient.device, recipient.device.deviceId, 1001),
    ).toThrow();
    expect(() => verifyPeerSignal(signal, sender.device, sender.device.deviceId, 1001)).toThrow();
  });

  it("refuses expired negotiation and relay candidates", () => {
    const sender = createPeerIdentity(new Uint8Array(32).fill(1), "Mac");
    const signal = signPeerSignal(sender, {
      sessionId: "session_test_0123456789",
      toDeviceId: sender.device.deviceId,
      issuedAt: 1000,
      description: { type: "offer", sdp },
    });
    expect(() => verifyPeerSignal(signal, sender.device, sender.device.deviceId, 2000)).toThrow();
    expect(() =>
      validateDirectDescription({ type: "offer", sdp: sdp.replace("typ host", "typ relay") }),
    ).toThrow();
    expect(() => validateStunServers(["turn:example.com:3478"])).toThrow();
    expect(validateStunServers(["stun:example.com:3478"])).toEqual(["stun:example.com:3478"]);
  });
});
