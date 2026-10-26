// @effect-diagnostics nodeBuiltinImport:off - The SSH bootstrap test observes its own spawned child.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_STATE_FILE } from "../cloud/serviceProtocol.ts";
import { prepareSshLauncher, runtimeOwnedByLauncher } from "./sshLauncher.ts";

const writeRuntime = (baseDir: string, version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const versionDir = path.join(baseDir, "runtime", "versions", version);
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(path.join(versionDir, "mines"), "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(path.join(versionDir, "mines"), 0o755);
    yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${version}\n`);
  });

const runtimeState = (pid: number) => ({
  version: 1,
  pid,
  port: 3773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-10-26T00:00:00.000Z",
});

it.layer(NodeServices.layer)("SSH service launcher preparation", (it) => {
  it.effect(
    "initializes a launcher from a verified installed runtime without touching user data",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-ssh-launcher-" });
        yield* writeRuntime(baseDir, "1.2.3");
        const userData = path.join(baseDir, "userdata", "account");
        yield* fs.makeDirectory(path.dirname(userData), { recursive: true });
        yield* fs.writeFileString(userData, "preserved");

        yield* Effect.promise(() => prepareSshLauncher(baseDir, "1.2.3"));

        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(path.join(baseDir, "runtime", SERVICE_STATE_FILE))),
          { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.2.3" },
        );
        assert.equal(yield* fs.readFileString(userData), "preserved");
      }).pipe(Effect.scoped),
  );

  it.effect("preserves a newer selected version and an in-progress update byte for byte", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-ssh-launcher-" });
      for (const version of ["1.2.3", "1.2.4", "1.2.5"]) yield* writeRuntime(baseDir, version);
      const statePath = path.join(baseDir, "runtime", SERVICE_STATE_FILE);
      const contents = JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.2.4",
        update: {
          id: "update-1",
          fromVersion: "1.2.4",
          targetVersion: "1.2.5",
          dbPath: path.join(baseDir, "userdata", "statev2.sqlite"),
          status: "pending",
        },
      });
      yield* fs.writeFileString(statePath, contents);

      yield* Effect.promise(() => prepareSshLauncher(baseDir, "1.2.3"));

      assert.equal(yield* fs.readFileString(statePath), contents);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses incomplete runtimes and live hosts without creating launcher state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-ssh-launcher-" });
      const rejected = (version: string) =>
        Effect.tryPromise(() => prepareSshLauncher(baseDir, version)).pipe(Effect.result);
      assert.equal((yield* rejected("../other"))._tag, "Failure");
      assert.equal((yield* rejected("1.2.3"))._tag, "Failure");
      yield* writeRuntime(baseDir, "1.2.3");
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "versions", "1.2.3", ".install-complete"),
        "1.2.2\n",
      );
      assert.equal((yield* rejected("1.2.3"))._tag, "Failure");
      yield* writeRuntime(baseDir, "1.2.3");
      const runtimeFile = path.join(baseDir, "userdata", "server-runtime.json");
      yield* fs.makeDirectory(path.dirname(runtimeFile), { recursive: true });
      yield* fs.writeFileString(runtimeFile, "invalid");
      assert.equal((yield* rejected("1.2.3"))._tag, "Failure");
      yield* fs.writeFileString(runtimeFile, JSON.stringify(runtimeState(process.pid)));
      assert.equal((yield* rejected("1.2.3"))._tag, "Failure");
      assert.isFalse(yield* fs.exists(path.join(baseDir, "runtime", SERVICE_STATE_FILE)));
    }).pipe(Effect.scoped),
  );

  it.effect("leaves invalid or unavailable selected state intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-ssh-launcher-" });
      yield* writeRuntime(baseDir, "1.2.3");
      const statePath = path.join(baseDir, "runtime", SERVICE_STATE_FILE);
      for (const contents of [
        "invalid",
        JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.2.4" }),
      ]) {
        yield* fs.writeFileString(statePath, contents);
        const result = yield* Effect.tryPromise(() => prepareSshLauncher(baseDir, "1.2.3")).pipe(
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        assert.equal(yield* fs.readFileString(statePath), contents);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("concurrent connections retain one complete launcher selection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-ssh-launcher-" });
      for (const version of ["1.2.3", "1.2.4"]) yield* writeRuntime(baseDir, version);

      yield* Effect.promise(() =>
        Promise.all([prepareSshLauncher(baseDir, "1.2.3"), prepareSshLauncher(baseDir, "1.2.4")]),
      );

      const selected = JSON.parse(
        yield* fs.readFileString(path.join(baseDir, "runtime", SERVICE_STATE_FILE)),
      );
      assert.equal(selected.protocol, SERVICE_LAUNCHER_PROTOCOL);
      assert.include(["1.2.3", "1.2.4"], selected.activeVersion);
      const contents = yield* fs.readFileString(path.join(baseDir, "runtime", SERVICE_STATE_FILE));
      yield* Effect.promise(() => prepareSshLauncher(baseDir, "1.2.3"));
      assert.equal(
        yield* fs.readFileString(path.join(baseDir, "runtime", SERVICE_STATE_FILE)),
        contents,
      );
    }).pipe(Effect.scoped),
  );
});

it.live("recognizes only the recorded launcher's actual live child", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mines-ssh-owned-" });
    const runtimeFile = path.join(baseDir, "server-runtime.json");
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready');process.stdin.resume()"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            child.stdout.once("data", () => resolve());
            child.once("error", reject);
          }),
      );
      const childPid = child.pid;
      if (childPid === undefined) throw new Error("Child did not start.");
      yield* fs.writeFileString(runtimeFile, JSON.stringify(runtimeState(childPid)));
      assert.isTrue(yield* Effect.promise(() => runtimeOwnedByLauncher(runtimeFile, process.pid)));
      assert.isFalse(yield* Effect.promise(() => runtimeOwnedByLauncher(runtimeFile, childPid)));
      assert.isFalse(yield* Effect.promise(() => runtimeOwnedByLauncher(runtimeFile, -1)));
    } finally {
      child.stdin.end();
      yield* Effect.promise(() => exited);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
