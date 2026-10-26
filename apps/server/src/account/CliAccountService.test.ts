import { expect, it } from "@effect/vitest";
import type { PeerConnectionState, PeerDeviceDirectory } from "@t3tools/contracts/minesPeer";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AccountControl from "./AccountControl.ts";
import * as CliAccountService from "./CliAccountService.ts";
import * as LocalAccountHost from "./LocalAccountHost.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const origin = "https://mines.example.test";
const user = { id: "account-a", name: "Pilot", email: "pilot@example.test", emailVerified: true };
const device = { deviceId: "device-000000000001", publicKey: "a".repeat(43), label: "CLI host" };
const other = { ...device, deviceId: "device-000000000002", label: "Mac" };
const connection: PeerConnectionState = {
  configured: true,
  online: true,
  controlUrl: origin,
  accountId: user.id,
  stunServers: [],
  failure: null,
};
const code = {
  deviceCode: "private-device-code",
  userCode: "ABCD-1234",
  verificationUri: `${origin}/device`,
  verificationUriComplete: `${origin}/device?user_code=ABCD-1234`,
  expiresIn: 300,
  interval: 5,
};

function fixture(
  options: {
    readonly saved?: boolean;
    readonly account?: Partial<AccountControl.AccountControl["Service"]>;
    readonly host?: Partial<LocalAccountHost.LocalAccountHost["Service"]>;
  } = {},
) {
  const values = new Map<string, Uint8Array>();
  const calls: string[] = [];
  if (options.saved)
    values.set(
      "mines-cli-account",
      new TextEncoder().encode(
        encodeJson({
          origin,
          token: "saved.signed-token",
          expiresAt: 1e12,
          user,
        }),
      ),
    );
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(values.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        calls.push("save");
        values.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        calls.push("clear");
        values.delete(key);
      }),
    create: () => Effect.die("Unexpected create"),
    getOrCreateRandom: () => Effect.die("Unexpected random secret"),
  });
  const account = AccountControl.AccountControl.of({
    origin,
    begin: Effect.succeed(code),
    poll: () =>
      Effect.succeed({
        _tag: "Granted",
        token: Redacted.make("new.signed-token"),
        expiresIn: 3600,
      }),
    identity: () => Effect.succeedSome(user),
    devices: () =>
      Effect.succeed({
        devices: [device, other],
        presence: [{ deviceId: other.deviceId, online: true }],
      } satisfies PeerDeviceDirectory),
    signOut: () =>
      Effect.sync(() => {
        calls.push("remote-revoke");
      }),
    ...options.account,
  });
  const host = LocalAccountHost.LocalAccountHost.of({
    bindAndConfigure: () =>
      Effect.sync(() => {
        calls.push("configure");
        return connection;
      }),
    disconnect: Effect.sync(() => {
      expect(values.size).toBe(0);
      calls.push("disconnect");
    }),
    state: Effect.succeed({ connection, device: { device, approvedDevices: [other] } }),
    status: Effect.succeed({ device, devices: [] }),
    check: (deviceId) =>
      Effect.succeed({
        deviceId,
        status: "approval-required",
        checkedAt: null,
        failure: "unapproved-device",
      }),
    pendingPairings: Effect.succeed([]),
    approvePairing: (code) =>
      Effect.sync(() => {
        calls.push(`approve:${code}`);
        return { code, requester: other };
      }),
    denyPairing: (code) =>
      Effect.sync(() => {
        calls.push(`deny:${code}`);
      }),
    ...options.host,
  });
  return {
    values,
    calls,
    layer: CliAccountService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AccountControl.AccountControl, account),
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
          Layer.succeed(LocalAccountHost.LocalAccountHost, host),
        ),
      ),
    ),
  };
}

it.effect(
  "waits for explicit device approval, respects slow-down, and persists before linking the host",
  () =>
    Effect.gen(function* () {
      const firstPoll = yield* Deferred.make<void>();
      let polls = 0;
      const test = fixture({
        account: {
          poll: () =>
            Effect.gen(function* () {
              polls++;
              if (polls === 1) {
                yield* Deferred.succeed(firstPoll, undefined);
                return { _tag: "Pending", slowDown: true } as const;
              }
              return {
                _tag: "Granted",
                token: Redacted.make("approved.signed-token"),
                expiresIn: 3600,
              } as const;
            }),
        },
      });
      yield* Effect.gen(function* () {
        const account = yield* CliAccountService.CliAccountService;
        const displayed: unknown[] = [];
        const fiber = yield* account
          .login((prompt) =>
            Effect.sync(() => {
              displayed.push(prompt);
            }),
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(firstPoll);
        expect(test.values.size).toBe(0);
        yield* TestClock.adjust("9 seconds");
        expect(polls).toBe(1);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        expect(result.user.id).toBe(user.id);
        expect(polls).toBe(2);
        expect(test.calls).toEqual(["save", "configure"]);
        expect(displayed).toEqual([
          {
            userCode: code.userCode,
            verificationUri: code.verificationUri,
            verificationUriComplete: code.verificationUriComplete,
            expiresIn: 300,
            interval: 5,
          },
        ]);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect(
  "keeps saved credentials and reports offline when account verification is unavailable",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        saved: true,
        account: {
          identity: () =>
            Effect.fail(new AccountControl.AccountControlError({ code: "unavailable" })),
        },
      });
      const status = yield* CliAccountService.CliAccountService.pipe(
        Effect.flatMap((account) => account.status),
        Effect.provide(test.layer),
      );
      expect(status.status).toBe("offline");
      expect(test.values.size).toBe(1);
      expect(test.calls).toEqual([]);
    }),
);

it.effect("clears the credential and stops the matching host when remote revocation fails", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      account: {
        signOut: () => Effect.fail(new AccountControl.AccountControlError({ code: "unavailable" })),
      },
    });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.logout),
      Effect.provide(test.layer),
    );
    expect(result).toEqual({ hostDisconnected: true, sessionRevoked: false, hostUnchanged: false });
    expect(test.calls).toEqual(["clear", "disconnect"]);
    expect(test.values.size).toBe(0);
  }),
);

it.effect("does not disconnect a host that switched to another account", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      host: {
        state: Effect.succeed({
          connection: { ...connection, accountId: "account-b" },
          device: { device, approvedDevices: [] },
        }),
      },
    });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.logout),
      Effect.provide(test.layer),
    );
    expect(result).toEqual({ hostDisconnected: false, sessionRevoked: true, hostUnchanged: true });
    expect(test.calls).toEqual(["clear", "remote-revoke"]);
  }),
);

it.effect(
  "reuses a verified saved account without another approval and rejects mismatched host binding",
  () =>
    Effect.gen(function* () {
      let disconnected = false;
      const test = fixture({
        saved: true,
        account: { begin: Effect.die("Must reuse saved account") },
        host: {
          bindAndConfigure: () => Effect.succeed({ ...connection, accountId: "account-b" }),
          disconnect: Effect.sync(() => {
            disconnected = true;
          }),
        },
      });
      const result = yield* CliAccountService.CliAccountService.pipe(
        Effect.flatMap((account) => account.login(() => Effect.die("Must not prompt"))),
        Effect.result,
        Effect.provide(test.layer),
      );
      expect(result._tag).toBe("Failure");
      expect(disconnected).toBe(true);
      expect(test.values.size).toBe(1);
    }),
);

it.effect(
  "keeps signaling presence separate from direct reachability and excludes other host account results",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        saved: true,
        host: {
          state: Effect.succeed({
            connection: { ...connection, accountId: "account-b" },
            device: { device, approvedDevices: [] },
          }),
          status: Effect.die("Must not read another account's status"),
        },
      });
      const devices = yield* CliAccountService.CliAccountService.pipe(
        Effect.flatMap((account) => account.devices),
        Effect.provide(test.layer),
      );
      expect(devices[1]).toMatchObject({
        signalingOnline: true,
        status: "not-tested",
        current: false,
        checkedAt: null,
      });
    }),
);

it.effect("reports an expired saved session without trying to validate it remotely", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      account: { identity: () => Effect.die("Expired sessions must not be checked") },
    });
    yield* TestClock.setTime(1e12 + 1);
    const status = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.status),
      Effect.provide(test.layer),
    );
    expect(status).toEqual({ status: "expired" });
    expect(test.values.size).toBe(1);
    expect(yield* Clock.currentTimeMillis).toBe(1e12 + 1);
  }),
);

it.effect("does not disconnect an unconfirmed host when reading its identity fails", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      host: {
        state: Effect.fail(new LocalAccountHost.LocalAccountHostError({ code: "unavailable" })),
        disconnect: Effect.die("Must not change an unconfirmed host"),
      },
    });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.logout),
      Effect.provide(test.layer),
    );
    expect(result).toEqual({ hostDisconnected: false, sessionRevoked: true, hostUnchanged: false });
    expect(test.values.size).toBe(0);
  }),
);

it.effect("expires an unapproved grant without persisting credentials or configuring a host", () =>
  Effect.gen(function* () {
    const test = fixture({
      account: {
        begin: Effect.succeed({ ...code, expiresIn: 5 }),
        poll: () => Effect.die("Expired grants must not be redeemed"),
      },
    });
    yield* Effect.gen(function* () {
      const account = yield* CliAccountService.CliAccountService;
      const fiber = yield* account.login(() => Effect.void).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      expect(test.values.size).toBe(0);
      expect(test.calls).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("preserves safe local-host diagnostics when linking a saved account fails", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      host: {
        bindAndConfigure: () =>
          Effect.fail(
            new LocalAccountHost.LocalAccountHostError({
              code: "unavailable",
              phase: "ticket",
              status: 401,
            }),
          ),
      },
    });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.login(() => Effect.void)),
      Effect.result,
      Effect.provide(test.layer),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("ticket (HTTP 401)");
    expect(test.values.size).toBe(1);
  }),
);

it.effect("approves a short code only for the verified account on the matching host", () =>
  Effect.gen(function* () {
    const test = fixture({ saved: true });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.approvePairing("ABCD-EFGH")),
      Effect.provide(test.layer),
    );
    expect(result).toEqual({ code: "ABCDEFGH", requester: other });
    expect(test.calls).toEqual(["approve:ABCDEFGH"]);
    expect(test.values.size).toBe(1);
  }),
);

it.effect("does not manage pairing requests on a host bound to another account", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      host: {
        state: Effect.succeed({
          connection: { ...connection, accountId: "account-b" },
          device: { device, approvedDevices: [] },
        }),
        pendingPairings: Effect.die("Must not list another account's requests"),
        approvePairing: () => Effect.die("Must not approve another account's request"),
        denyPairing: () => Effect.die("Must not deny another account's request"),
      },
    });
    yield* Effect.gen(function* () {
      const account = yield* CliAccountService.CliAccountService;
      for (const operation of [
        account.pendingPairings,
        account.approvePairing("ABCD-EFGH"),
        account.denyPairing("ABCD-EFGH"),
      ]) {
        const result = yield* Effect.result(operation);
        expect(result._tag).toBe("Failure");
      }
    }).pipe(Effect.provide(test.layer));
    expect(test.calls).toEqual([]);
    expect(test.values.size).toBe(1);
  }),
);

it.effect("does not approve device access after the saved account is revoked", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      account: { identity: () => Effect.succeedNone },
      host: { approvePairing: () => Effect.die("Must not approve for a revoked account") },
    });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.approvePairing("ABCD-EFGH")),
      Effect.result,
      Effect.provide(test.layer),
    );
    expect(result._tag).toBe("Failure");
    expect(test.calls).toEqual([]);
    expect(test.values.size).toBe(1);
  }),
);

it.effect("rejects an invalid device code without forwarding an approval", () =>
  Effect.gen(function* () {
    const test = fixture({ saved: true });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.approvePairing("not-a-valid-code")),
      Effect.result,
      Effect.provide(test.layer),
    );
    expect(result._tag).toBe("Failure");
    expect(test.calls).toEqual([]);
  }),
);

it.effect("reports an expired device request without asking the user to sign in again", () =>
  Effect.gen(function* () {
    const test = fixture({
      saved: true,
      host: {
        approvePairing: () =>
          Effect.fail(
            new LocalAccountHost.LocalAccountHostError({
              code: "unavailable",
              phase: "rpc",
              pairingFailure: "expired",
            }),
          ),
      },
    });
    const result = yield* CliAccountService.CliAccountService.pipe(
      Effect.flatMap((account) => account.approvePairing("ABCD-EFGH")),
      Effect.result,
      Effect.provide(test.layer),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("device request expired");
      expect(result.failure.message).not.toContain("account login");
    }
    expect(test.values.size).toBe(1);
  }),
);
