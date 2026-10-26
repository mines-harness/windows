import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import {
  PeerDevice,
  PeerDeviceProof,
  PeerError,
  PeerSignal,
  type PeerDescription,
} from "@t3tools/contracts/minesPeer";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { GroupPeerEnvelope, type GroupPeerRequest, type EnvironmentId } from "@t3tools/contracts";

import { stableStringify } from "./relaySigning.ts";

export interface PeerIdentity {
  readonly device: PeerDevice;
  readonly privateKey: Uint8Array;
}

export function peerAccountNamespace(accountId: string): string {
  return Base64Url.encode(sha256(new TextEncoder().encode(accountId)));
}

const encoder = new TextEncoder();
const decodeSignal = Schema.decodeUnknownSync(PeerSignal);
const decodeDevice = Schema.decodeUnknownSync(PeerDevice);
const decodeProof = Schema.decodeUnknownSync(PeerDeviceProof);
const decodeGroupEnvelope = Schema.decodeSync(GroupPeerEnvelope);

export function signPeerDeviceProof(
  identity: PeerIdentity,
  action: PeerDeviceProof["action"],
  nonce: string,
  issuedAt: number,
): PeerDeviceProof {
  const unsigned = { device: identity.device, action, nonce, issuedAt };
  return decodeProof({
    ...unsigned,
    signature: Base64Url.encode(
      ed25519.sign(encoder.encode(stableStringify(unsigned)), identity.privateKey),
    ),
  });
}

export function verifyPeerDeviceProof(
  value: unknown,
  action: PeerDeviceProof["action"],
  nowSeconds: number,
): PeerDeviceProof {
  const proof = decodeProof(value);
  if (
    proof.action !== action ||
    proof.issuedAt > nowSeconds + 15 ||
    proof.issuedAt < nowSeconds - 60
  )
    throw new PeerError({ code: "expired-signal" });
  const { signature, ...unsigned } = proof;
  const publicKey = Result.getOrThrow(Base64Url.decode(proof.device.publicKey));
  if (
    Base64Url.encode(sha256(publicKey)) !== proof.device.deviceId ||
    !ed25519.verify(
      Result.getOrThrow(Base64Url.decode(signature)),
      encoder.encode(stableStringify(unsigned)),
      publicKey,
    )
  )
    throw new PeerError({ code: "invalid-signature" });
  return proof;
}

export function createPeerIdentity(
  privateKey: Uint8Array,
  label: string,
  platform?: PeerDevice["platform"],
): PeerIdentity {
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey: privateKey.slice(),
    device: decodeDevice({
      deviceId: Base64Url.encode(sha256(publicKey)),
      publicKey: Base64Url.encode(publicKey),
      label,
      ...(platform ? { platform } : {}),
    }),
  };
}

export function validateStunServers(servers: ReadonlyArray<string>): string[] {
  if (
    servers.length > 4 ||
    servers.some(
      (server) => !/^stuns?:[a-zA-Z0-9.[\]:_-]+(?:\?transport=(?:udp|tcp))?$/.test(server),
    )
  ) {
    throw new PeerError({ code: "relay-forbidden" });
  }
  return [...servers];
}

export function validateDirectDescription(description: PeerDescription): string {
  const fingerprints = [
    ...description.sdp.matchAll(/^a=fingerprint:sha-256 ([\dA-Fa-f:]+)\r?$/gm),
  ].map((match) => match[1]!.toUpperCase());
  if (
    fingerprints.length === 0 ||
    fingerprints.some(
      (value) => !/^(?:[\dA-F]{2}:){31}[\dA-F]{2}$/.test(value) || value !== fingerprints[0],
    )
  ) {
    throw new PeerError({ code: "invalid-description" });
  }
  for (const line of description.sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const candidateType = /\styp\s+(\S+)/.exec(line)?.[1];
    if (!candidateType || !["host", "srflx", "prflx"].includes(candidateType))
      throw new PeerError({ code: "relay-forbidden" });
  }
  return fingerprints[0]!;
}

export function signPeerSignal(
  identity: PeerIdentity,
  input: {
    readonly sessionId: string;
    readonly toDeviceId: string;
    readonly issuedAt: number;
    readonly description: PeerDescription;
    readonly sharedGroupKey?: string;
    readonly phase?: "ready";
  },
): PeerSignal {
  validateDirectDescription(input.description);
  const unsigned = {
    version: 1 as const,
    ...input,
    fromDeviceId: identity.device.deviceId,
    expiresAt: input.issuedAt + 60,
  };
  const signature = Base64Url.encode(
    ed25519.sign(encoder.encode(stableStringify(unsigned)), identity.privateKey),
  );
  return decodeSignal({ ...unsigned, signature });
}

export function verifyPeerSignal(
  value: unknown,
  approved: PeerDevice,
  recipientDeviceId: string,
  nowSeconds: number,
): PeerSignal {
  const signal = decodeSignal(value);
  if (signal.fromDeviceId !== approved.deviceId || signal.toDeviceId !== recipientDeviceId)
    throw new PeerError({ code: "unapproved-device" });
  if (
    signal.issuedAt > nowSeconds + 15 ||
    signal.expiresAt < nowSeconds ||
    signal.expiresAt - signal.issuedAt > 60 ||
    signal.expiresAt <= signal.issuedAt
  )
    throw new PeerError({ code: "expired-signal" });
  const { signature, ...unsigned } = signal;
  const publicKey = Result.getOrThrow(Base64Url.decode(approved.publicKey));
  if (
    Base64Url.encode(sha256(publicKey)) !== approved.deviceId ||
    !ed25519.verify(
      Result.getOrThrow(Base64Url.decode(signature)),
      encoder.encode(stableStringify(unsigned)),
      publicKey,
    )
  )
    throw new PeerError({ code: "invalid-signature" });
  validateDirectDescription(signal.description);
  return signal;
}

export function isDirectCandidatePair(
  pair: {
    readonly local: { readonly type: string };
    readonly remote: { readonly type: string };
  } | null,
): boolean {
  return (
    pair !== null &&
    [pair.local.type, pair.remote.type].every((type) => ["host", "srflx", "prflx"].includes(type))
  );
}

/** Application messages bind the coordinator identity and destination, independently of bearer scope. */
export function signGroupPeerEnvelope(
  identity: PeerIdentity,
  input: {
    readonly fromEnvironmentId: EnvironmentId;
    readonly toEnvironmentId: EnvironmentId;
    readonly toDeviceId: string;
    readonly issuedAt: number;
    readonly nonce: string;
    readonly request: GroupPeerRequest;
  },
): GroupPeerEnvelope {
  const unsigned = { version: 1 as const, ...input, fromDeviceId: identity.device.deviceId };
  return decodeGroupEnvelope({
    ...unsigned,
    signature: Base64Url.encode(
      ed25519.sign(encoder.encode(stableStringify(unsigned)), identity.privateKey),
    ),
  });
}

export function verifyGroupPeerEnvelope(
  input: GroupPeerEnvelope,
  approved: PeerDevice,
  recipient: {
    readonly environmentId: EnvironmentId;
    readonly deviceId: string;
  },
  nowSeconds: number,
): boolean {
  if (
    input.fromDeviceId !== approved.deviceId ||
    input.toEnvironmentId !== recipient.environmentId ||
    input.toDeviceId !== recipient.deviceId ||
    input.issuedAt > nowSeconds + 15 ||
    input.issuedAt < nowSeconds - 60
  )
    return false;
  const { signature, ...unsigned } = input;
  const publicKey = Result.getOrThrow(Base64Url.decode(approved.publicKey));
  return (
    Base64Url.encode(sha256(publicKey)) === approved.deviceId &&
    ed25519.verify(
      Result.getOrThrow(Base64Url.decode(signature)),
      encoder.encode(stableStringify(unsigned)),
      publicKey,
    )
  );
}
