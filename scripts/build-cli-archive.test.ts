// @effect-diagnostics nodeBuiltinImport:off - Inspect the actual gzip archive for nonportable extended metadata.
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, live } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import rootPackageJson from "../package.json" with { type: "json" };

import { cliArchiveTarArguments, finalizeCliArchiveContents } from "./build-cli-archive.ts";
import { windowsSystemTar } from "./lib/windows-tar.ts";

live(
  "public CLI contents omit source maps while preserving runtime files and license notices",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "mines-archive-public-" });
      const repo = path.join(scratch, "repo");
      const content = path.join(scratch, "runtime");
      yield* fs.makeDirectory(path.join(repo, "scripts/resources"), { recursive: true });
      yield* fs.writeFileString(path.join(repo, "LICENSE"), "MIT fixture license\n");
      yield* fs.writeFileString(
        path.join(repo, "scripts/resources", `node-v${rootPackageJson.engines.node}-LICENSE`),
        "Node fixture license\n",
      );
      const runtimeFiles = [
        "mines",
        "client/index.html",
        "client/assets/app.js",
        "client/third-party-licenses.json",
        "node_modules/sdk/dist/index.js",
        "node_modules/sdk/LICENSE.md",
        "node_modules/native/build/addon.node",
      ];
      const sourceMaps = [
        "client/assets/app.js.map",
        "node_modules/sdk/dist/index.js.map",
        "node_modules/sdk/dist/nested/types.d.ts.map",
      ];
      for (const file of [...runtimeFiles, ...sourceMaps]) {
        const target = path.join(content, file);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, file);
      }

      yield* finalizeCliArchiveContents(repo, content);

      for (const file of runtimeFiles) {
        assert.strictEqual(yield* fs.readFileString(path.join(content, file)), file);
      }
      for (const file of sourceMaps) {
        assert.isFalse(yield* fs.exists(path.join(content, file)));
      }
      assert.strictEqual(
        yield* fs.readFileString(path.join(content, "LICENSE")),
        "MIT fixture license\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(content, "NODE_LICENSE")),
        "Node fixture license\n",
      );
      const notices = yield* fs.readFileString(path.join(content, "THIRD_PARTY_NOTICES.md"));
      assert.include(notices, "T3 Tools Inc.");
      assert.include(notices, "client/third-party-licenses.json");
    }).pipe(Effect.provide(NodeServices.layer)),
);

live("CLI archives omit filesystem metadata that Linux tar cannot read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "mines-archive-metadata-" });
    const content = path.join(scratch, "runtime");
    const executable = path.join(content, "mines");
    yield* fs.makeDirectory(content);
    yield* fs.writeFileString(executable, "#!/bin/sh\nexit 0\n");
    if (platform === "darwin") {
      const xattr = yield* spawner.spawn(
        ChildProcess.make("xattr", ["-w", "com.apple.mines-test", "metadata", executable]),
      );
      assert.strictEqual(Number(yield* xattr.exitCode), 0);
    }
    const archive = path.join(scratch, "runtime.tar.gz");
    const tarCommand = platform === "win32" ? windowsSystemTar() : "tar";
    const tar = yield* spawner.spawn(
      ChildProcess.make(tarCommand, cliArchiveTarArguments(archive, scratch, "runtime", platform), {
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    assert.strictEqual(Number(yield* tar.exitCode), 0);
    const contents = NodeZlib.gunzipSync(yield* fs.readFile(archive)).toString("utf8");
    assert.notInclude(contents, "LIBARCHIVE.xattr.");
    assert.notInclude(contents, "SCHILY.xattr.");
    assert.include(contents, "#!/bin/sh\nexit 0\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);
