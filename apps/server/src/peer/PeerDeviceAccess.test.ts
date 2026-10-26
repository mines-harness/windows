import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { peerDeviceAccessSubject } from "./PeerDeviceAccess.ts";

const layer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mines-peer-access-test-" })),
    Layer.provide(NodeServices.layer),
  );

it.effect(
  "failed pairing cleanup revokes its exchanged session without touching another attempt",
  () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const failed = peerDeviceAccessSubject("device", "failed-request");
      const other = peerDeviceAccessSubject("device", "other-request");
      const grant = yield* auth.createPairingLink({
        subject: failed,
        scopes: ["orchestration:read"],
      });
      yield* auth.exchangeBootstrapCredentialForAccessToken(grant.credential, undefined, {
        label: "Same label",
        deviceType: "desktop",
      });
      yield* auth.createPairingLink({ subject: other });
      yield* auth.issueSession({ subject: other, label: "Same label" });
      yield* auth.issueSession({ subject: "browser", label: "Same label" });
      expect((yield* auth.listSessions()).map((session) => session.subject)).toContain(failed);
      yield* auth.revokeDevicePairingAccess("device", "failed-request");
      expect((yield* auth.listSessions()).map((session) => session.subject).sort()).toEqual(
        ["browser", other].sort(),
      );
      expect((yield* auth.listPairingLinks()).map((link) => link.subject)).toEqual([other]);
    }).pipe(Effect.provide(layer())),
);

it.effect("device revocation removes all its new pairing grants and sessions only", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    for (const subject of [
      peerDeviceAccessSubject("device", "first"),
      peerDeviceAccessSubject("device", "second"),
      peerDeviceAccessSubject("another-device", "first"),
      "one-time-token",
    ]) {
      yield* auth.createPairingLink({ subject });
      yield* auth.issueSession({ subject });
    }
    yield* auth.revokeDevicePairingAccess("device");
    const expected = [peerDeviceAccessSubject("another-device", "first"), "one-time-token"].sort();
    expect((yield* auth.listPairingLinks()).map((grant) => grant.subject).sort()).toEqual(expected);
    expect((yield* auth.listSessions()).map((session) => session.subject).sort()).toEqual(expected);
  }).pipe(Effect.provide(layer())),
);
