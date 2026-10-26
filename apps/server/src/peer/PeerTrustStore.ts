import { PeerDevice, type PeerDevice as PeerDeviceType } from "@t3tools/contracts/minesPeer";
import {
  createPeerIdentity,
  peerAccountNamespace,
  type PeerIdentity,
} from "@t3tools/shared/minesPeerTrust";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class PeerTrustAccountChangedError extends Schema.TaggedError<PeerTrustAccountChangedError>()(
  "PeerTrustAccountChangedError",
  {},
) {
  override get message(): string {
    return "The selected Mines account changed.";
  }
}

interface AccountIdentity {
  readonly accountId: string;
  readonly deviceId: string;
}

type TrustError =
  | ServerSecretStore.SecretStoreError
  | Schema.SchemaError
  | PeerTrustAccountChangedError;

export interface PeerApprovalLease {
  readonly rollback: Effect.Effect<boolean, TrustError>;
}

export class PeerTrustStore extends Context.Service<
  PeerTrustStore,
  {
    readonly selectAccount: (
      accountId: string | null,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly identity: Effect.Effect<PeerIdentity, ServerSecretStore.SecretStoreError>;
    readonly list: Effect.Effect<
      ReadonlyArray<PeerDeviceType>,
      ServerSecretStore.SecretStoreError | Schema.SchemaError
    >;
    readonly approve: (
      device: PeerDeviceType,
      account?: AccountIdentity,
    ) => Effect.Effect<
      void,
      ServerSecretStore.SecretStoreError | Schema.SchemaError | PeerTrustAccountChangedError
    >;
    readonly beginApproval: (
      device: PeerDeviceType,
      account: AccountIdentity,
    ) => Effect.Effect<PeerApprovalLease, TrustError>;
    readonly revoke: (
      deviceId: string,
      account?: AccountIdentity,
    ) => Effect.Effect<
      void,
      ServerSecretStore.SecretStoreError | Schema.SchemaError | PeerTrustAccountChangedError
    >;
  }
>()("mines/peer/PeerTrustStore") {}

const DevicesJson = Schema.fromJsonString(Schema.Array(PeerDevice));
const decodeDevices = Schema.decodeEffect(DevicesJson);
const encodeDevices = Schema.encodeEffect(DevicesJson);
const decodeDevice = Schema.decodeEffect(PeerDevice);
const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const label = (yield* HostProcess.Hostname).trim().slice(0, 80) || "Mines computer";
  const hostPlatform = yield* HostProcess.Platform;
  const platform =
    hostPlatform === "darwin"
      ? "macos"
      : hostPlatform === "win32"
        ? "windows"
        : hostPlatform === "linux"
          ? "linux"
          : undefined;
  const lock = yield* Semaphore.make(1);
  const revisions = new Map<string, symbol>();
  const savedAccount = yield* secrets.get("mines-peer-account");
  let namespace = Option.isSome(savedAccount)
    ? new TextDecoder().decode(savedAccount.value)
    : "unassigned";
  const identityFor = Effect.fn("PeerTrustStore.identityFor")((selected: string) =>
    secrets
      .getOrCreateRandom(`mines-peer-identity-${selected}`, 32)
      .pipe(Effect.map((key) => createPeerIdentity(key, label, platform))),
  );
  const identity = Effect.suspend(() => identityFor(namespace));
  const read = Effect.fn("PeerTrustStore.read")(function* (selected: string) {
    const stored = yield* secrets.get(`mines-approved-peers-${selected}`);
    return Option.isSome(stored)
      ? yield* decodeDevices(new TextDecoder().decode(stored.value))
      : [];
  });
  const list = Effect.suspend(() => read(namespace));
  const save = Effect.fn("PeerTrustStore.save")(function* (
    selected: string,
    devices: ReadonlyArray<PeerDeviceType>,
  ) {
    const value = yield* encodeDevices(devices);
    yield* secrets.set(`mines-approved-peers-${selected}`, new TextEncoder().encode(value));
  });
  const checkedNamespace = Effect.fn("PeerTrustStore.checkedNamespace")(function* (
    account: AccountIdentity | undefined,
    requireSelected: boolean,
  ) {
    const selected = account ? peerAccountNamespace(account.accountId) : namespace;
    if (
      account &&
      ((requireSelected && selected !== namespace) ||
        (yield* identityFor(selected)).device.deviceId !== account.deviceId)
    )
      return yield* new PeerTrustAccountChangedError({});
    return selected;
  });
  return PeerTrustStore.of({
    selectAccount: Effect.fn("PeerTrustStore.selectAccount")((accountId) =>
      lock.withPermit(
        Effect.gen(function* () {
          const next = accountId === null ? "unassigned" : peerAccountNamespace(accountId);
          yield* secrets.set("mines-peer-account", new TextEncoder().encode(next));
          namespace = next;
        }).pipe(Effect.uninterruptible),
      ),
    ),
    identity,
    list,
    approve: Effect.fn("PeerTrustStore.approve")(function* (device, account) {
      yield* decodeDevice(device);
      yield* lock.withPermit(
        Effect.gen(function* () {
          const selected = yield* checkedNamespace(account, true);
          const devices = yield* read(selected);
          yield* save(selected, [
            ...devices.filter((entry) => entry.deviceId !== device.deviceId),
            device,
          ]);
          revisions.delete(`${selected}:${device.deviceId}`);
        }).pipe(Effect.uninterruptible),
      );
    }),
    beginApproval: Effect.fn("PeerTrustStore.beginApproval")(function* (device, account) {
      yield* decodeDevice(device);
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const selected = yield* checkedNamespace(account, true);
          const devices = yield* read(selected);
          if (
            devices.some(
              (entry) => entry.deviceId === device.deviceId && entry.publicKey === device.publicKey,
            )
          )
            return { rollback: Effect.succeed(false) };
          const key = `${selected}:${device.deviceId}`;
          const revision = Symbol();
          yield* save(selected, [
            ...devices.filter((entry) => entry.deviceId !== device.deviceId),
            device,
          ]);
          revisions.set(key, revision);
          return {
            rollback: lock.withPermit(
              Effect.gen(function* () {
                if (revisions.get(key) !== revision) return false;
                yield* checkedNamespace(account, false);
                yield* save(
                  selected,
                  (yield* read(selected)).filter((entry) => entry.deviceId !== device.deviceId),
                );
                revisions.delete(key);
                return true;
              }).pipe(Effect.uninterruptible),
            ),
          };
        }).pipe(Effect.uninterruptible),
      );
    }),
    revoke: Effect.fn("PeerTrustStore.revoke")(function* (deviceId, account) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          const selected = yield* checkedNamespace(account, false);
          yield* save(
            selected,
            (yield* read(selected)).filter((device) => device.deviceId !== deviceId),
          );
          revisions.delete(`${selected}:${deviceId}`);
        }).pipe(Effect.uninterruptible),
      );
    }),
  });
});

export const layer = Layer.effect(PeerTrustStore, make);
