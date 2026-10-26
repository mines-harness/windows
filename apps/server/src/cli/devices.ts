import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { accountJsonFlag, formatAccountJson, runWithAccount } from "./account.ts";
import { authLocationFlags } from "./config.ts";

const list = Command.make("list", { ...authLocationFlags, json: accountJsonFlag }).pipe(
  Command.withDescription(
    "List your account's devices, signaling presence, and last direct checks.",
  ),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const devices = yield* account.devices;
        if (flags.json) {
          yield* Console.log(formatAccountJson({ devices }));
          return;
        }
        if (devices.length === 0) {
          yield* Console.log("No devices registered for this account.");
          return;
        }
        for (const entry of devices)
          yield* Console.log(
            `${entry.device.label}${entry.current ? " (this host)" : ""}\n  ${entry.device.deviceId}\n  Signaling: ${entry.signalingOnline ? "online" : "offline"}; direct: ${entry.status}${entry.checkedAt ? ` (checked ${entry.checkedAt})` : ""}`,
          );
      }),
    ),
  ),
);
const check = Command.make("check", {
  ...authLocationFlags,
  json: accountJsonFlag,
  deviceId: Argument.String("device-id"),
}).pipe(
  Command.withDescription("Test an approved device with a direct authenticated handshake."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const result = yield* account.checkDevice(flags.deviceId);
        yield* Console.log(
          flags.json
            ? formatAccountJson(result)
            : `${result.deviceId}: ${result.status}${result.failure ? ` (${result.failure})` : ""}`,
        );
      }),
    ),
  ),
);

const pending = Command.make("pending", {
  ...authLocationFlags,
  json: accountJsonFlag,
}).pipe(
  Command.withDescription("Show devices waiting for permission to use this host."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const requests = yield* account.pendingPairings;
        if (flags.json) {
          yield* Console.log(
            formatAccountJson({
              requests: requests.map((request) => ({
                code: request.code,
                requester: request.requester.label,
              })),
            }),
          );
          return;
        }
        if (!requests.length) {
          yield* Console.log("No devices are waiting for approval.");
          return;
        }
        for (const request of requests)
          yield* Console.log(
            `${request.requester.label}\n  Code: ${request.code}\n  Approve: mines devices approve ${request.code}`,
          );
      }),
    ),
  ),
);

const approve = Command.make("approve", {
  ...authLocationFlags,
  json: accountJsonFlag,
  code: Argument.String("code"),
}).pipe(
  Command.withDescription("Approve a device's short code and allow it to use this host."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        const result = yield* account.approvePairing(flags.code);
        yield* Console.log(
          flags.json
            ? formatAccountJson({
                status: "approved",
                code: result.code,
                requester: result.requester.label,
              })
            : `${result.requester.label} approved. Return to that device to finish connecting.`,
        );
      }),
    ),
  ),
);

const deny = Command.make("deny", {
  ...authLocationFlags,
  json: accountJsonFlag,
  code: Argument.String("code"),
}).pipe(
  Command.withDescription("Decline a device's request to use this host."),
  Command.withHandler((flags) =>
    runWithAccount(flags, (account) =>
      Effect.gen(function* () {
        yield* account.denyPairing(flags.code);
        yield* Console.log(
          flags.json ? formatAccountJson({ status: "denied" }) : "Device request declined.",
        );
      }),
    ),
  ),
);
export const devicesCommand = Command.make("devices").pipe(
  Command.withDescription("Find and check devices on your Mines account."),
  Command.withSubcommands([list, check, pending, approve, deny]),
);
