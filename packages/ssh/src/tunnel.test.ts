import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = {
  archiveVersion: "1.2.3-preview.20260911.4",
  releaseBaseUrl: "https://releases.example/download",
} as const;

const makeArchiveRunnerFixture = Effect.fn("ssh.test.makeArchiveRunnerFixture")(function* (
  executableVersion: string = ARCHIVE.archiveVersion,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "mines-ssh-archive-test-" });
  const bin = path.join(home, "bin");
  const fixtures = path.join(home, "releases");
  const archiveRoot = path.join(home, "release");
  const fetchLog = path.join(home, "fetch.log");
  yield* fs.makeDirectory(bin);
  yield* fs.makeDirectory(fixtures);
  yield* fs.makeDirectory(archiveRoot);
  yield* fs.writeFileString(
    path.join(archiveRoot, "mines"),
    `#!/bin/sh
case "$1" in
  --version) printf 'mines v%s\\n' '${executableVersion}' ;;
  *) printf 'mines fixture %s\\n' "$*" ;;
esac
`,
  );
  yield* fs.chmod(path.join(archiveRoot, "mines"), 0o755);
  const archiveName = `mines-${ARCHIVE.archiveVersion}-linux-x64.tar.gz`;
  const archivePath = path.join(fixtures, archiveName);
  assert.equal(
    yield* spawner.exitCode(ChildProcess.make("tar", ["-czf", archivePath, "-C", home, "release"])),
    0,
  );
  const archiveBytes = yield* fs.readFile(archivePath);
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new Uint8Array(archiveBytes)),
  );
  const checksum = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const checksumsPath = path.join(fixtures, "SHA256SUMS");
  yield* fs.writeFileString(checksumsPath, `${checksum}  ${archiveName}\n`);
  yield* fs.writeFileString(
    path.join(bin, "curl"),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) destination="$2"; shift 2 ;;
    https://*) source="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$source" >> "$FETCH_LOG"
cp "$FIXTURES/\${source##*/}" "$destination"
`,
  );
  yield* fs.writeFileString(
    path.join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) printf "Linux\\n" ;; -m) printf "x86_64\\n" ;; esac\n',
  );
  yield* fs.chmod(path.join(bin, "curl"), 0o755);
  yield* fs.chmod(path.join(bin, "uname"), 0o755);
  const runner = path.join(home, "runner.sh");
  yield* fs.writeFileString(runner, SshTunnel.buildRemoteMinesRunnerScript(ARCHIVE));
  const runFile = (file: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", [file, ...args], {
          env: {
            HOME: home,
            PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            FIXTURES: fixtures,
            FETCH_LOG: fetchLog,
          },
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText, Stream.mkString),
          child.stderr.pipe(Stream.decodeText, Stream.mkString),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });
  return {
    home,
    run: (args: ReadonlyArray<string>) => runFile(runner, args),
    runScript: (script: string, args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const file = path.join(home, "launch.sh");
        yield* fs.writeFileString(file, script);
        return yield* runFile(file, args);
      }),
    checksumsPath,
    archiveName,
    fetchLog,
    runtimeDirectory: path.join(home, ".mines", "runtime", "versions", ARCHIVE.archiveVersion),
  };
});

const captureRemoteLaunchScript = Effect.gen(function* () {
  let script = "";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.equal(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") return makeSuccessfulProcess("");
      const stdin = command.options.stdin;
      assert.isObject(stdin);
      if (
        typeof stdin !== "object" ||
        stdin === null ||
        !("stream" in stdin) ||
        typeof stdin.stream === "string"
      ) {
        return makeSuccessfulProcess("");
      }
      script = yield* stdin.stream.pipe(Stream.decodeText, Stream.mkString);
      return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}\n');
    }),
  );
  yield* SshTunnel.launchOrReuseRemoteServer(
    { alias: "fixture", hostname: "fixture.invalid", username: null, port: null },
    undefined,
    ARCHIVE,
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  return script;
});

describe("ssh tunnel scripts", () => {
  it.live("starts an updateable launcher in the existing home with its pinned release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fixture = yield* makeArchiveRunnerFixture();
      assert.equal((yield* fixture.run(["--version"])).exitCode, 0);
      const signal = path.join(fixture.home, "ready");
      assert.equal(yield* spawner.exitCode(ChildProcess.make("mkfifo", [signal])), 0);
      yield* fs.writeFileString(
        path.join(fixture.runtimeDirectory, "mines"),
        `#!/bin/sh
set -eu
case "$1" in
  --version) printf '%s\\n' '${ARCHIVE.archiveVersion}' ;;
  __ssh-helper)
    case "$2" in
      runtime-port) exit 1 ;;
      pick-port) printf '3773' ;;
      prepare-launcher) printf '%s|%s' "$3" "$4" > "$HOME/prepared" ;;
      wait-ready) read -r ready < "$HOME/ready" ;;
    esac ;;
  __service-launcher)
    printf '%s|%s|%s|%s' "$MINES_HOME" "$MINES_HOST" "$MINES_PORT" "$MINES_CLI_RELEASE_BASE_URL" > "$HOME/launched"
    printf 'ready\\n' > "$HOME/ready" ;;
esac
`,
      );
      const result = yield* fixture.runScript(yield* captureRemoteLaunchScript, ["fixture"]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, '{"remotePort":3773,"serverKind":"managed"}\n');
      assert.equal(
        yield* fs.readFileString(path.join(fixture.home, "prepared")),
        `${fixture.home}/.mines|${ARCHIVE.archiveVersion}`,
      );
      assert.equal(
        yield* fs.readFileString(path.join(fixture.home, "launched")),
        `${fixture.home}/.mines|127.0.0.1|3773|${ARCHIVE.releaseBaseUrl}`,
      );
      assert.equal(
        yield* fs.readFileString(path.join(fixture.home, ".mines/ssh-launch/fixture/launcher")),
        yield* fs.readFileString(path.join(fixture.home, ".mines/ssh-launch/fixture/pid")),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reconnects without restarting its running launcher after a runner change", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fixture = yield* makeArchiveRunnerFixture();
      assert.equal((yield* fixture.run(["--version"])).exitCode, 0);
      const launcher = yield* spawner.spawn(
        ChildProcess.make("cat", [], { stdin: { stream: Stream.never, endOnDone: true } }),
      );
      const stateDir = path.join(fixture.home, ".mines/ssh-launch/fixture");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "pid"), `${launcher.pid}\n`);
      yield* fs.writeFileString(path.join(stateDir, "launcher"), `${launcher.pid}\n`);
      yield* fs.writeFileString(path.join(stateDir, "port"), "3773\n");
      yield* fs.writeFileString(path.join(stateDir, "managed"), "managed\n");
      yield* fs.writeFileString(path.join(stateDir, "run-t3.sh"), "previous runner\n");
      yield* fs.writeFileString(
        path.join(fixture.runtimeDirectory, "mines"),
        `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' '${ARCHIVE.archiveVersion}' ;;
  __ssh-helper)
    case "$2" in
      runtime-port) printf '999999 3773' ;;
      runtime-owned | wait-ready) exit 0 ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`,
      );
      const result = yield* fixture.runScript(yield* captureRemoteLaunchScript, ["fixture"]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, '{"remotePort":3773,"serverKind":"managed"}\n');
      assert.equal(yield* launcher.isRunning, true);
      assert.equal(yield* fs.readFileString(path.join(stateDir, "pid")), `${launcher.pid}\n`);
      const executable = path.join(fixture.runtimeDirectory, "mines");
      yield* fs.writeFileString(
        executable,
        (yield* fs.readFileString(executable)).replace(
          "runtime-owned | wait-ready) exit 0",
          "runtime-owned) exit 1 ;; wait-ready) exit 0",
        ),
      );
      const unconfirmed = yield* fixture.runScript(yield* captureRemoteLaunchScript, ["fixture"]);
      assert.notEqual(unconfirmed.exitCode, 0);
      assert.include(unconfirmed.stderr, "existing host was left running");
      assert.equal(yield* launcher.isRunning, true);
      assert.equal(yield* fs.readFileString(path.join(stateDir, "pid")), `${launcher.pid}\n`);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("installs and reuses a verified Mines archive executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeArchiveRunnerFixture();
      assert.deepEqual(yield* fixture.run(["--version"]), {
        stdout: `mines v${ARCHIVE.archiveVersion}\n`,
        stderr: "",
        exitCode: 0,
      });
      assert.equal(
        yield* fs.readFileString(path.join(fixture.runtimeDirectory, ".install-complete")),
        `${ARCHIVE.archiveVersion}\n`,
      );
      yield* fs.remove(fixture.checksumsPath);
      assert.deepEqual(yield* fixture.run(["serve", "--port", "3773"]), {
        stdout: "mines fixture serve --port 3773\n",
        stderr: "",
        exitCode: 0,
      });
      assert.deepEqual((yield* fs.readFileString(fixture.fetchLog)).trim().split("\n"), [
        `${ARCHIVE.releaseBaseUrl}/v${ARCHIVE.archiveVersion}/SHA256SUMS`,
        `${ARCHIVE.releaseBaseUrl}/v${ARCHIVE.archiveVersion}/${fixture.archiveName}`,
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a corrupt SSH archive without marking the runtime installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeArchiveRunnerFixture();
      yield* fs.writeFileString(
        fixture.checksumsPath,
        `${"0".repeat(64)}  ${fixture.archiveName}\n`,
      );
      const result = yield* fixture.run(["--version"]);
      assert.notEqual(result.exitCode, 0);
      assert.include(result.stderr, `Checksum mismatch for ${fixture.archiveName}`);
      assert.equal(yield* fs.exists(fixture.runtimeDirectory), false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a verified SSH archive containing a different executable version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeArchiveRunnerFixture("0.0.1");
      const result = yield* fixture.run(["--version"]);
      assert.notEqual(result.exitCode, 0);
      assert.equal(yield* fs.exists(fixture.runtimeDirectory), false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("rejects archive bootstrap without an explicit mines release source", () => {
    assert.throws(
      () => SshTunnel.buildRemoteMinesRunnerScript({ archiveVersion: "1.2.3" }),
      /Configure/,
    );
    assert.throws(
      () =>
        SshTunnel.buildRemoteMinesRunnerScript({
          archiveVersion: "1.2.3",
          releaseBaseUrl: "https://github.com/pingdotgg/t3code/releases/download",
        }),
      /Configure/,
    );
    assert.include(SshTunnel.buildRemoteMinesRunnerScript(ARCHIVE), "mines-$MINES_ARCHIVE_VERSION");
    assert.include(
      SshTunnel.buildRemoteMinesRunnerScript(ARCHIVE),
      "$HOME/.mines/runtime/versions",
    );
  });

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteMinesRunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteMinesRunnerScript(ARCHIVE),
      "MINES_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.
