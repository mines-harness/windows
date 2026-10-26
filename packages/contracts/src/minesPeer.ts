import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,128}$/));
const PublicKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/));

export const PeerDevicePlatform = Schema.Literals(["macos", "windows", "linux", "ios", "android"]);
export type PeerDevicePlatform = typeof PeerDevicePlatform.Type;

export const PeerDevice = Schema.Struct({
  deviceId: Identifier,
  publicKey: PublicKey,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  platform: Schema.optionalKey(PeerDevicePlatform),
});
export type PeerDevice = typeof PeerDevice.Type;

export const PeerDeviceDirectory = Schema.Struct({
  devices: Schema.Array(PeerDevice).check(Schema.isMaxLength(100)),
  presence: Schema.Array(Schema.Struct({ deviceId: Identifier, online: Schema.Boolean }))
    .check(Schema.isMaxLength(100))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type PeerDeviceDirectory = typeof PeerDeviceDirectory.Type;

export const PeerDeviceProof = Schema.Struct({
  device: PeerDevice,
  action: Schema.Literals(["register", "ticket"]),
  nonce: Identifier,
  issuedAt: Schema.Int,
  signature: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{86}$/)),
});
export type PeerDeviceProof = typeof PeerDeviceProof.Type;

export const PeerDescription = Schema.Struct({
  type: Schema.Literals(["offer", "answer"]),
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
});
export type PeerDescription = typeof PeerDescription.Type;

export const PeerSignal = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Identifier,
  fromDeviceId: Identifier,
  toDeviceId: Identifier,
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
  description: PeerDescription,
  sharedGroupKey: Schema.optionalKey(Identifier),
  phase: Schema.optionalKey(Schema.Literal("ready")),
  signature: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{86}$/)),
});
export type PeerSignal = typeof PeerSignal.Type;

export const PeerChannel = Schema.Literals(["rpc", "resource", "catalog", "shared-group"]);
export type PeerChannel = typeof PeerChannel.Type;

export const PeerRpcOpen = Schema.Struct({
  type: Schema.Literal("mines.rpc.open"),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
});
export type PeerRpcOpen = typeof PeerRpcOpen.Type;

export const PeerResourceRequest = Schema.Struct({
  id: Identifier,
  method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  headers: Schema.Record(Schema.String, Schema.String),
  encoding: Schema.Literal("base64"),
  body: Schema.optionalKey(Schema.String),
});
export type PeerResourceRequest = typeof PeerResourceRequest.Type;

export const PeerResourceResponse = Schema.Struct({
  id: Identifier,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  headers: Schema.Record(Schema.String, Schema.String),
  encoding: Schema.Literal("base64"),
  body: Schema.String,
});
export type PeerResourceResponse = typeof PeerResourceResponse.Type;

export const PeerFailureCode = Schema.Literals([
  "unapproved-device",
  "invalid-signature",
  "expired-signal",
  "replayed-signal",
  "relay-forbidden",
  "invalid-description",
  "direct-unavailable",
  "closed",
  "frame-too-large",
]);
export type PeerFailureCode = typeof PeerFailureCode.Type;

export const PeerConfigure = Schema.Struct({
  controlUrl: Schema.String.check(Schema.isMaxLength(2048)),
  bearerToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  stunServers: Schema.Array(Schema.String).check(Schema.isMaxLength(4)),
});
export type PeerConfigure = typeof PeerConfigure.Type;

export const PeerConnectionState = Schema.Struct({
  configured: Schema.Boolean,
  online: Schema.Boolean,
  controlUrl: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  stunServers: Schema.Array(Schema.String),
  failure: Schema.NullOr(PeerFailureCode),
});
export type PeerConnectionState = typeof PeerConnectionState.Type;

export class PeerError extends Schema.TaggedError<PeerError>()("PeerError", {
  code: PeerFailureCode,
}) {
  override get message(): string {
    switch (this.code) {
      case "unapproved-device":
        return "Approve this device on the host before connecting.";
      case "direct-unavailable":
        return "A direct connection could not be established on this network.";
      case "relay-forbidden":
        return "Mines permits direct peer connections only.";
      case "closed":
        return "The peer connection is closed.";
      default:
        return "The peer connection could not be verified.";
    }
  }
}
