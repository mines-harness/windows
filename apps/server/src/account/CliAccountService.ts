import type { PeerDeviceStatus } from "@t3tools/contracts";
import type { PeerDevice, PeerConnectionState } from "@t3tools/contracts/minesPeer";
import {
  DevicePairingCode,
  type DevicePairingApproval,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AccountControl from "./AccountControl.ts";
import * as LocalAccountHost from "./LocalAccountHost.ts";

const credentialName = "mines-cli-account";
const SavedAccount = Schema.Struct({
  origin: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
  user: AccountControl.AccountUser,
});
type SavedAccount = typeof SavedAccount.Type;
const decodeSavedAccount = Schema.decodeEffect(Schema.fromJsonString(SavedAccount));
const encodeSavedAccount = Schema.encodeEffect(Schema.fromJsonString(SavedAccount));

export class CliAccountError extends Schema.TaggedError<CliAccountError>()("CliAccountError", {
  message: Schema.String,
}) {}

export type AccountStatus =
  | { readonly status: "signed-out" }
  | { readonly status: "expired" }
  | {
      readonly status: "signed-in" | "offline";
      readonly user: AccountControl.AccountUser;
      readonly host: PeerConnectionState | null;
    };

export interface AccountDevice {
  readonly device: PeerDevice;
  readonly current: boolean;
  readonly signalingOnline: boolean;
  readonly status: PeerDeviceStatus["status"];
  readonly checkedAt: string | null;
  readonly failure: PeerDeviceStatus["failure"];
}

export class CliAccountService extends Context.Service<
  CliAccountService,
  {
    readonly login: (
      onCode: (code: Omit<AccountControl.DeviceCode, "deviceCode">) => Effect.Effect<void>,
    ) => Effect.Effect<
      { readonly user: AccountControl.AccountUser; readonly host: PeerConnectionState },
      CliAccountError
    >;
    readonly status: Effect.Effect<AccountStatus, CliAccountError>;
    readonly logout: Effect.Effect<
      {
        readonly hostDisconnected: boolean;
        readonly sessionRevoked: boolean;
        readonly hostUnchanged: boolean;
      },
      CliAccountError
    >;
    readonly devices: Effect.Effect<ReadonlyArray<AccountDevice>, CliAccountError>;
    readonly checkDevice: (deviceId: string) => Effect.Effect<PeerDeviceStatus, CliAccountError>;
    readonly pendingPairings: Effect.Effect<ReadonlyArray<DevicePairingRequest>, CliAccountError>;
    readonly approvePairing: (
      code: string,
    ) => Effect.Effect<DevicePairingApproval, CliAccountError>;
    readonly denyPairing: (code: string) => Effect.Effect<void, CliAccountError>;
  }
>()("mines/account/CliAccountService") {}

const error = (message: string) => new CliAccountError({ message });
const storageError = () =>
  error("Cannot access the CLI account credential. Check permissions on the Mines data directory.");
const hostError = (cause: LocalAccountHost.LocalAccountHostError) =>
  error(
    cause.pairingFailure
      ? cause.message
      : cause.message + " Run `mines account login` again with the running host's --base-dir.",
  );
const sessionError = () => error("Sign in first with `mines account login`.");
const decodePairingCode = Schema.decodeUnknownEffect(DevicePairingCode);
const pairingCode = Effect.fn("CliAccountService.decodePairingCode")((code: string) =>
  decodePairingCode(code.replace(/[\s-]/g, "").toUpperCase()).pipe(
    Effect.mapError(() => error("Enter the eight-character code shown on the device.")),
  ),
);

export const layer = Layer.effect(
  CliAccountService,
  Effect.gen(function* () {
    const control = yield* AccountControl.AccountControl;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const host = yield* LocalAccountHost.LocalAccountHost;
    const read = Effect.fn("CliAccountService.read")(function* () {
      const bytes = yield* secrets.get(credentialName).pipe(Effect.mapError(storageError));
      if (Option.isNone(bytes)) return Option.none<SavedAccount>();
      const saved = yield* decodeSavedAccount(new TextDecoder().decode(bytes.value)).pipe(
        Effect.mapError(storageError),
      );
      return saved.origin === control.origin ? Option.some(saved) : Option.none<SavedAccount>();
    });
    const save = Effect.fn("CliAccountService.save")(function* (saved: SavedAccount) {
      const json = yield* encodeSavedAccount(saved).pipe(Effect.mapError(storageError));
      yield* secrets
        .set(credentialName, new TextEncoder().encode(json))
        .pipe(Effect.mapError(storageError));
    });
    const clear = secrets.remove(credentialName).pipe(Effect.mapError(storageError));
    const savedSession = Effect.fn("CliAccountService.savedSession")(function* () {
      const saved = yield* read();
      if (Option.isNone(saved)) return yield* sessionError();
      if (saved.value.expiresAt <= (yield* Clock.currentTimeMillis)) return yield* sessionError();
      return saved.value;
    });
    const validate = Effect.fn("CliAccountService.validate")(function* (saved: SavedAccount) {
      const user = yield* control
        .identity(Redacted.make(saved.token))
        .pipe(Effect.mapError((cause) => error(cause.message)));
      if (Option.isNone(user) || user.value.id !== saved.user.id) return yield* sessionError();
      return user.value;
    });
    const requireMatchingHost = Effect.fn("CliAccountService.requireMatchingHost")(function* () {
      const saved = yield* savedSession();
      yield* validate(saved);
      const local = yield* host.state.pipe(Effect.mapError(hostError));
      if (
        local.connection.accountId !== saved.user.id ||
        local.connection.controlUrl !== control.origin
      )
        return yield* error(
          "Connect this host to your account with `mines account login` before managing device approvals.",
        );
    });
    const configure = Effect.fn("CliAccountService.configure")(function* (saved: SavedAccount) {
      const configured = yield* host
        .bindAndConfigure({
          controlUrl: control.origin,
          bearerToken: saved.token,
          stunServers: [`stun:${new URL(control.origin).hostname}:3478`],
        })
        .pipe(Effect.mapError(hostError));
      if (configured.accountId !== saved.user.id || configured.controlUrl !== control.origin) {
        yield* host.disconnect.pipe(Effect.ignore);
        return yield* error(
          "The local host returned a different account identity. Device sync was stopped.",
        );
      }
      return configured;
    });
    const login = Effect.fn("CliAccountService.login")(function* (
      onCode: (code: Omit<AccountControl.DeviceCode, "deviceCode">) => Effect.Effect<void>,
    ) {
      const cached = yield* read();
      if (Option.isSome(cached) && cached.value.expiresAt > (yield* Clock.currentTimeMillis)) {
        const user = yield* control
          .identity(Redacted.make(cached.value.token))
          .pipe(Effect.mapError((cause) => error(cause.message)));
        if (Option.isSome(user) && user.value.id === cached.value.user.id) {
          return { user: user.value, host: yield* configure(cached.value) };
        }
      }
      const code = yield* control.begin.pipe(Effect.mapError((cause) => error(cause.message)));
      const deadline = (yield* Clock.currentTimeMillis) + code.expiresIn * 1000;
      yield* onCode({
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        verificationUriComplete: code.verificationUriComplete,
        expiresIn: code.expiresIn,
        interval: code.interval,
      });
      let interval = code.interval;
      while (true) {
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0)
          return yield* error("The sign-in code expired. Run `mines account login` again.");
        yield* Effect.sleep(Math.min(interval * 1000, remaining));
        if ((yield* Clock.currentTimeMillis) >= deadline)
          return yield* error("The sign-in code expired. Run `mines account login` again.");
        const result = yield* control
          .poll(code.deviceCode)
          .pipe(Effect.mapError((cause) => error(cause.message)));
        if (result._tag === "Pending") {
          if (result.slowDown) interval += 5;
          continue;
        }
        const identity = yield* control
          .identity(result.token)
          .pipe(Effect.mapError((cause) => error(cause.message)));
        if (Option.isNone(identity)) return yield* sessionError();
        const saved = {
          origin: control.origin,
          token: Redacted.value(result.token),
          expiresAt: (yield* Clock.currentTimeMillis) + result.expiresIn * 1000,
          user: identity.value,
        };
        yield* save(saved);
        return { user: identity.value, host: yield* configure(saved) };
      }
    });
    const status = Effect.gen(function* () {
      const cached = yield* read();
      if (Option.isNone(cached)) return { status: "signed-out" } as const;
      if (cached.value.expiresAt <= (yield* Clock.currentTimeMillis))
        return { status: "expired" } as const;
      const identity = yield* control
        .identity(Redacted.make(cached.value.token))
        .pipe(Effect.result);
      const local = yield* host.state.pipe(Effect.option);
      const connection =
        Option.isSome(local) &&
        local.value.connection.accountId === cached.value.user.id &&
        local.value.connection.controlUrl === control.origin
          ? local.value.connection
          : null;
      if (identity._tag === "Failure") {
        if (identity.failure.code === "unavailable")
          return { status: "offline", user: cached.value.user, host: connection } as const;
        return yield* error(identity.failure.message);
      }
      if (Option.isNone(identity.success) || identity.success.value.id !== cached.value.user.id)
        return { status: "expired" } as const;
      return { status: "signed-in", user: identity.success.value, host: connection } as const;
    });
    const logout = Effect.gen(function* () {
      const cached = yield* read().pipe(Effect.orElseSucceed(() => Option.none<SavedAccount>()));
      yield* clear;
      const state = Option.isSome(cached) ? yield* host.state.pipe(Effect.option) : Option.none();
      const hostUnchanged =
        Option.isNone(cached) ||
        (Option.isSome(state) &&
          (state.value.connection.accountId !== cached.value.user.id ||
            state.value.connection.controlUrl !== control.origin));
      const hostDisconnected =
        !hostUnchanged && Option.isSome(state)
          ? yield* host.disconnect.pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : false;
      const sessionRevoked =
        Option.isNone(cached) ||
        (yield* control.signOut(Redacted.make(cached.value.token)).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ));
      return { hostDisconnected, sessionRevoked, hostUnchanged };
    });
    const devices = Effect.gen(function* () {
      const saved = yield* savedSession();
      yield* validate(saved);
      const directory = yield* control
        .devices(Redacted.make(saved.token))
        .pipe(Effect.mapError((cause) => error(cause.message)));
      const localState = yield* host.state.pipe(Effect.option);
      const ownHost =
        Option.isSome(localState) &&
        localState.value.connection.accountId === saved.user.id &&
        localState.value.connection.controlUrl === control.origin;
      const local = ownHost ? yield* host.status.pipe(Effect.option) : Option.none();
      return directory.devices.map((device): AccountDevice => {
        const checked = Option.isSome(local)
          ? local.value.devices.find((entry) => entry.device.deviceId === device.deviceId)
          : undefined;
        return {
          device,
          current: Option.isSome(local) && local.value.device.deviceId === device.deviceId,
          signalingOnline: directory.presence.some(
            (entry) => entry.deviceId === device.deviceId && entry.online,
          ),
          status: checked?.status ?? "not-tested",
          checkedAt: checked?.checkedAt ?? null,
          failure: checked?.failure ?? null,
        };
      });
    });
    return CliAccountService.of({
      login,
      status,
      logout,
      devices,
      pendingPairings: Effect.gen(function* () {
        yield* requireMatchingHost();
        return yield* host.pendingPairings.pipe(Effect.mapError(hostError));
      }),
      approvePairing: Effect.fn("CliAccountService.approvePairing")(function* (code) {
        yield* requireMatchingHost();
        const value = yield* pairingCode(code);
        return yield* host.approvePairing(value).pipe(Effect.mapError(hostError));
      }),
      denyPairing: Effect.fn("CliAccountService.denyPairing")(function* (code) {
        yield* requireMatchingHost();
        const value = yield* pairingCode(code);
        yield* host.denyPairing(value).pipe(Effect.mapError(hostError));
      }),
      checkDevice: Effect.fn("CliAccountService.checkDevice")(function* (deviceId) {
        const saved = yield* savedSession();
        yield* validate(saved);
        const directory = yield* control
          .devices(Redacted.make(saved.token))
          .pipe(Effect.mapError((cause) => error(cause.message)));
        if (!directory.devices.some((device) => device.deviceId === deviceId))
          return yield* error("This device does not belong to your signed-in account.");
        const local = yield* host.state.pipe(Effect.mapError(hostError));
        if (
          local.connection.accountId !== saved.user.id ||
          local.connection.controlUrl !== control.origin
        )
          return yield* error(
            "Connect this host to your account with `mines account login` before checking devices.",
          );
        return yield* host.check(deviceId).pipe(Effect.mapError(hostError));
      }),
    });
  }),
);
