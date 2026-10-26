import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as TestConsole from "effect/testing/TestConsole";

import * as AccountControl from "../account/AccountControl.ts";

import { makeCli } from "../binCli.ts";

const runtime = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  TestConsole.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);

it.effect(
  "account status reports signed-out JSON without starting a server or requesting authentication",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mines-account-cli-" });
      let requests = 0;
      const fetch: typeof globalThis.fetch = async () => {
        requests++;
        throw new AccountControl.AccountControlError({ code: "unavailable" });
      };
      yield* Command.runWith(makeCli(), { version: "0.0.0" })([
        "account",
        "status",
        "--base-dir",
        directory,
        "--json",
      ]).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      expect(yield* TestConsole.logLines).toContain('{"status":"signed-out"}');
      expect(requests).toBe(0);
      expect(yield* fs.exists(path.join(directory, "userdata", "server-runtime.json"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect("devices list asks for account sign-in without falling through to server startup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mines-devices-cli-" });
    const failure = yield* Command.runWith(makeCli(), { version: "0.0.0" })([
      "devices",
      "list",
      "--base-dir",
      directory,
      "--json",
    ]).pipe(Effect.flip);
    expect(failure.message).toContain("Sign in first with `mines account login`");
    expect(yield* fs.exists(path.join(directory, "userdata", "server-runtime.json"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(runtime)),
);

it.effect("device pairing commands require sign-in without starting a server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const command of [["pending"], ["approve", "ABCD-EFGH"], ["deny", "ABCD-EFGH"]]) {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "mines-pairing-cli-" });
      const failure = yield* Command.runWith(makeCli(), { version: "0.0.0" })([
        "devices",
        ...command,
        "--base-dir",
        directory,
        "--json",
      ]).pipe(Effect.flip);
      expect(failure.message).toContain("Sign in first with `mines account login`");
      expect(yield* fs.exists(path.join(directory, "userdata", "server-runtime.json"))).toBe(false);
    }
  }).pipe(Effect.scoped, Effect.provide(runtime)),
);
