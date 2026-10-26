import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import {
  DevicePairingCommand,
  DevicePairingError,
  DevicePairingRequest,
  DevicePairingResult,
  type DevicePairingEnvelope,
} from "@t3tools/contracts/minesDevicePairing";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodePeerPairing } from "./minesPeerPairing.ts";
import { registerPeerDevice } from "./minesPeerSignaling.ts";
import type { PeerIdentity } from "./minesPeerTrust.ts";
import { stableStringify } from "./relaySigning.ts";

type Unsigned<Command> = Command extends unknown
  ? Omit<Command, "version" | "device" | "signature">
  : never;
type DevicePairingAction = Unsigned<DevicePairingCommand>;
type Operation<Action> = Action extends unknown ? Omit<Action, "nonce" | "issuedAt"> : never;
export interface DevicePairingContext {
  readonly controlUrl: string;
  readonly identity: PeerIdentity;
  readonly nowSeconds: () => number;
  readonly randomId: () => string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}
export interface DevicePairingSession {
  readonly request: DevicePairingRequest;
  readonly privateKey: Uint8Array;
}
export type DevicePairingClientCollection =
  | { readonly status: "pending" | "denied" | "cancelled" | "expired" }
  | { readonly status: "approved"; readonly pairingUrl: string };

const encode = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
const decodeCommand = Schema.decodeUnknownSync(DevicePairingCommand);
const decodeRequest = Schema.decodeUnknownSync(DevicePairingRequest);
const decodeResult = Schema.decodeUnknownSync(DevicePairingResult);
const decodeError = Schema.decodeUnknownSync(
  Schema.Struct({ error: DevicePairingError.fields.code }),
);
const forbidden = () => new DevicePairingError({ code: "forbidden" });
const isDevicePairingError = Schema.is(DevicePairingError);
const bytes = (value: string) => Result.getOrThrow(Base64Url.decode(value));

function normalizeDevicePairingCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function signDevicePairingCommand(
  identity: PeerIdentity,
  input: DevicePairingAction,
): DevicePairingCommand {
  try {
    // V1 clients strip newer display metadata before verifying pairing proofs.
    const { deviceId, publicKey, label } = identity.device;
    const unsigned = { ...input, version: 1, device: { deviceId, publicKey, label } };
    return decodeCommand({
      ...unsigned,
      signature: Base64Url.encode(
        ed25519.sign(encode.encode(stableStringify(unsigned)), identity.privateKey),
      ),
    });
  } catch {
    throw new DevicePairingError({ code: "invalid-input" });
  }
}

export function verifyDevicePairingCommand(
  value: unknown,
  nowSeconds: number,
  maxAgeSeconds = 60,
): DevicePairingCommand {
  try {
    const command = decodeCommand(value);
    if (command.issuedAt > nowSeconds + 15 || command.issuedAt < nowSeconds - maxAgeSeconds)
      throw new DevicePairingError({ code: "expired" });
    const { signature, ...unsigned } = command;
    const publicKey = bytes(command.device.publicKey);
    if (
      Base64Url.encode(sha256(publicKey)) !== command.device.deviceId ||
      !ed25519.verify(bytes(signature), encode.encode(stableStringify(unsigned)), publicKey)
    )
      throw forbidden();
    return command;
  } catch (error) {
    if (isDevicePairingError(error)) throw error;
    throw forbidden();
  }
}

function verifiedRequest(value: unknown, now: number): DevicePairingRequest {
  try {
    const request = decodeRequest(value);
    const proof = verifyDevicePairingCommand(request.proof, now, 300);
    const expires = Date.parse(request.expiresAt) / 1000;
    if (expires <= now) throw new DevicePairingError({ code: "expired" });
    if (
      proof.action !== "request" ||
      proof.id !== request.id ||
      proof.device.deviceId !== request.requester.deviceId ||
      proof.device.publicKey !== request.requester.publicKey ||
      proof.targetDeviceId !== request.target.deviceId ||
      proof.responsePublicKey !== request.responsePublicKey ||
      !Number.isFinite(expires) ||
      expires > proof.issuedAt + 300 ||
      Base64Url.encode(sha256(bytes(request.target.publicKey))) !== request.target.deviceId
    )
      throw forbidden();
    return request;
  } catch (error) {
    if (isDevicePairingError(error)) throw error;
    throw forbidden();
  }
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  )
    throw forbidden();
  return new URL("/v1/device-pairings", url);
}

async function execute(context: DevicePairingContext, action: Operation<DevicePairingAction>) {
  const command = signDevicePairingCommand(context.identity, {
    ...action,
    nonce: context.randomId(),
    issuedAt: context.nowSeconds(),
  } as DevicePairingAction);
  try {
    const response = await (context.fetch ?? globalThis.fetch)(endpoint(context.controlUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      credentials: "omit",
      redirect: "error",
      signal: context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (text.length > 96 * 1024) throw forbidden();
    const value: unknown = JSON.parse(text);
    if (!response.ok) {
      let code: DevicePairingError["code"] = "unavailable";
      try {
        code = decodeError(value).error;
      } catch {}
      throw new DevicePairingError({ code });
    }
    return decodeResult(value);
  } catch (error) {
    if (isDevicePairingError(error)) throw error;
    throw new DevicePairingError({ code: "unavailable" });
  }
}

function binding(request: DevicePairingRequest) {
  return encode.encode(
    `mines-device-pairing-v1:${request.id}:${request.requester.deviceId}:${request.target.deviceId}`,
  );
}
async function envelopeKey(
  privateKey: Uint8Array,
  publicKey: string,
  request: DevicePairingRequest,
) {
  const secret = x25519.getSharedSecret(privateKey, bytes(publicKey));
  const material = hkdf(
    sha256,
    secret,
    encode.encode("mines-device-pairing-v1"),
    binding(request),
    32,
  );
  return crypto.subtle.importKey("raw", Uint8Array.from(material), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
async function encryptPairing(
  request: DevicePairingRequest,
  pairingUrl: string,
): Promise<DevicePairingEnvelope> {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await envelopeKey(privateKey, request.responsePublicKey, request);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: binding(request) },
    key,
    encode.encode(pairingUrl),
  );
  const publicKey = Base64Url.encode(x25519.getPublicKey(privateKey));
  privateKey.fill(0);
  return {
    publicKey,
    nonce: Base64Url.encode(nonce),
    ciphertext: Base64Url.encode(new Uint8Array(encrypted)),
  };
}

export async function beginDevicePairing(
  context: DevicePairingContext & {
    readonly targetDeviceId: string;
    readonly bearerToken: () => Promise<string>;
  },
): Promise<DevicePairingSession> {
  await registerPeerDevice(context);
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const responsePublicKey = Base64Url.encode(x25519.getPublicKey(privateKey));
  const id = context.randomId();
  const result = await execute(context, {
    action: "request",
    id,
    targetDeviceId: context.targetDeviceId,
    responsePublicKey,
  });
  if (!("request" in result)) throw forbidden();
  const request = verifiedRequest(result.request, context.nowSeconds());
  if (
    request.id !== id ||
    request.responsePublicKey !== responsePublicKey ||
    request.target.deviceId !== context.targetDeviceId ||
    request.requester.deviceId !== context.identity.device.deviceId
  )
    throw forbidden();
  return { request, privateKey };
}

export async function collectDevicePairing(
  context: DevicePairingContext & { readonly pairing: DevicePairingSession },
): Promise<DevicePairingClientCollection> {
  const request = verifiedRequest(context.pairing.request, context.nowSeconds());
  if (
    request.requester.deviceId !== context.identity.device.deviceId ||
    request.requester.publicKey !== context.identity.device.publicKey ||
    request.responsePublicKey !== Base64Url.encode(x25519.getPublicKey(context.pairing.privateKey))
  )
    throw forbidden();
  const result = await execute(context, { action: "check", id: request.id });
  if (!("status" in result)) throw forbidden();
  if (result.status !== "approved") {
    if (result.status !== "pending") context.pairing.privateKey.fill(0);
    return result;
  }
  const approved = verifyDevicePairingCommand(result.approval, context.nowSeconds(), 300);
  if (
    approved.action !== "approve" ||
    approved.id !== request.id ||
    approved.device.deviceId !== request.target.deviceId ||
    approved.device.publicKey !== request.target.publicKey
  )
    throw forbidden();
  try {
    const key = await envelopeKey(context.pairing.privateKey, approved.envelope.publicKey, request);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(bytes(approved.envelope.nonce)),
        additionalData: binding(request),
      },
      key,
      Uint8Array.from(bytes(approved.envelope.ciphertext)),
    );
    const pairingUrl = decode.decode(plaintext);
    const payload = decodePeerPairing(pairingUrl, context.nowSeconds());
    if (
      payload.host.deviceId !== request.target.deviceId ||
      payload.host.publicKey !== request.target.publicKey ||
      new URL(payload.controlUrl).origin !== new URL(context.controlUrl).origin
    )
      throw forbidden();
    return { status: "approved", pairingUrl };
  } catch (error) {
    if (isDevicePairingError(error)) throw error;
    throw forbidden();
  } finally {
    context.pairing.privateKey.fill(0);
  }
}

export async function cancelDevicePairing(
  context: DevicePairingContext & { readonly pairing: DevicePairingSession },
): Promise<void> {
  try {
    const result = await execute(context, { action: "cancel", id: context.pairing.request.id });
    if (!("ok" in result)) throw forbidden();
  } finally {
    context.pairing.privateKey.fill(0);
  }
}
export async function listDevicePairings(
  context: DevicePairingContext,
): Promise<DevicePairingRequest[]> {
  const result = await execute(context, { action: "pending" });
  if (!("requests" in result)) throw forbidden();
  return result.requests.map((value) => {
    const request = verifiedRequest(value, context.nowSeconds());
    if (
      request.target.deviceId !== context.identity.device.deviceId ||
      request.target.publicKey !== context.identity.device.publicKey
    )
      throw forbidden();
    return request;
  });
}
export async function reviewDevicePairing(
  context: DevicePairingContext & { readonly code: string },
): Promise<DevicePairingRequest> {
  const result = await execute(context, {
    action: "review",
    code: normalizeDevicePairingCode(context.code),
  });
  if (!("request" in result)) throw forbidden();
  const request = verifiedRequest(result.request, context.nowSeconds());
  if (
    request.target.deviceId !== context.identity.device.deviceId ||
    request.target.publicKey !== context.identity.device.publicKey
  )
    throw forbidden();
  return request;
}
export async function completeDevicePairing(
  context: DevicePairingContext & {
    readonly request: DevicePairingRequest;
    readonly pairingUrl: string;
  },
): Promise<void> {
  const request = verifiedRequest(context.request, context.nowSeconds());
  if (
    request.target.deviceId !== context.identity.device.deviceId ||
    request.target.publicKey !== context.identity.device.publicKey
  )
    throw forbidden();
  const payload = decodePeerPairing(context.pairingUrl, context.nowSeconds());
  if (
    payload.host.deviceId !== context.identity.device.deviceId ||
    payload.host.publicKey !== context.identity.device.publicKey ||
    new URL(payload.controlUrl).origin !== new URL(context.controlUrl).origin
  )
    throw forbidden();
  const envelope = await encryptPairing(request, context.pairingUrl);
  const result = await execute(context, { action: "approve", id: request.id, envelope });
  if (!("ok" in result)) throw forbidden();
}
export async function denyDevicePairing(
  context: DevicePairingContext & { readonly code: string },
): Promise<void> {
  const result = await execute(context, {
    action: "deny",
    code: normalizeDevicePairingCode(context.code),
  });
  if (!("ok" in result)) throw forbidden();
}
