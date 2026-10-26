import * as Schema from "effect/Schema";
import { AuthGrantScopes } from "./auth.ts";
import { PeerDevice } from "./minesPeer.ts";

const Identifier = PeerDevice.fields.deviceId;
const PublicKey = PeerDevice.fields.publicKey;
export const DevicePairingCode = Schema.String.check(Schema.isPattern(/^[A-Z2-9]{8}$/));
const Signed = {
  version: Schema.Literal(1),
  device: PeerDevice,
  nonce: Identifier,
  issuedAt: Schema.Int,
  signature: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{86}$/)),
};
export const DevicePairingEnvelope = Schema.Struct({
  publicKey: PublicKey,
  nonce: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16}$/)),
  ciphertext: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(65_536)),
});
export type DevicePairingEnvelope = typeof DevicePairingEnvelope.Type;
export const DevicePairingRequestCommand = Schema.Struct({
  ...Signed,
  action: Schema.Literal("request"),
  id: Identifier,
  targetDeviceId: Identifier,
  responsePublicKey: PublicKey,
});
export type DevicePairingRequestCommand = typeof DevicePairingRequestCommand.Type;
export const DevicePairingApproveCommand = Schema.Struct({
  ...Signed,
  action: Schema.Literal("approve"),
  id: Identifier,
  envelope: DevicePairingEnvelope,
});
export type DevicePairingApproveCommand = typeof DevicePairingApproveCommand.Type;
export const DevicePairingCommand = Schema.Union([
  DevicePairingRequestCommand,
  DevicePairingApproveCommand,
  Schema.Struct({ ...Signed, action: Schema.Literal("check"), id: Identifier }),
  Schema.Struct({ ...Signed, action: Schema.Literal("cancel"), id: Identifier }),
  Schema.Struct({ ...Signed, action: Schema.Literal("pending") }),
  Schema.Struct({ ...Signed, action: Schema.Literal("review"), code: DevicePairingCode }),
  Schema.Struct({ ...Signed, action: Schema.Literal("deny"), code: DevicePairingCode }),
]);
export type DevicePairingCommand = typeof DevicePairingCommand.Type;
export const DevicePairingRequest = Schema.Struct({
  id: Identifier,
  code: DevicePairingCode,
  expiresAt: Schema.String.check(Schema.isMaxLength(40)),
  requester: PeerDevice,
  target: PeerDevice,
  responsePublicKey: PublicKey,
  proof: DevicePairingRequestCommand,
});
export type DevicePairingRequest = typeof DevicePairingRequest.Type;
export const DevicePairingCollection = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "denied", "cancelled", "expired"]) }),
  Schema.Struct({ status: Schema.Literal("approved"), approval: DevicePairingApproveCommand }),
]);
export type DevicePairingCollection = typeof DevicePairingCollection.Type;
export const DevicePairingResult = Schema.Union([
  Schema.Struct({ request: DevicePairingRequest }),
  Schema.Struct({ requests: Schema.Array(DevicePairingRequest).check(Schema.isMaxLength(8)) }),
  Schema.Struct({ ok: Schema.Literal(true) }),
  DevicePairingCollection,
]);
export type DevicePairingResult = typeof DevicePairingResult.Type;
export const DevicePairingApproval = Schema.Struct({
  code: DevicePairingCode,
  requester: PeerDevice,
});
export type DevicePairingApproval = typeof DevicePairingApproval.Type;
export const DevicePairingApproveInput = Schema.Struct({
  code: DevicePairingCode,
  scopes: AuthGrantScopes,
});
export const DevicePairingCodeInput = Schema.Struct({ code: DevicePairingCode });
export class DevicePairingError extends Schema.TaggedError<DevicePairingError>()(
  "DevicePairingError",
  {
    code: Schema.Literals([
      "invalid-input",
      "forbidden",
      "not-found",
      "expired",
      "conflict",
      "limit",
      "unavailable",
    ]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "invalid-input":
        return "This device request is invalid.";
      case "forbidden":
        return "This device request could not be verified for your account.";
      case "not-found":
        return "This device request is no longer available.";
      case "expired":
        return "This device request expired. Start a new connection.";
      case "conflict":
        return "This device request has already been answered.";
      case "limit":
        return "Too many device requests. Try again shortly.";
      case "unavailable":
        return "The device service is unavailable. Try again.";
    }
  }
}
