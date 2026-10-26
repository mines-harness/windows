// @effect-diagnostics nodeBuiltinImport:off - SSH bootstrap shares the standalone launcher's native persistence boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";

import {
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  type ServiceState,
} from "../cloud/serviceProtocol.ts";
import { isProcessAlive, PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { readServiceState, writeServiceState } from "../serviceLauncher.ts";

const decodeRuntime = Schema.decodeSync(Schema.fromJsonString(PersistedServerRuntimeState));
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const hasCode = (cause: unknown, code: string) =>
  cause instanceof Error && "code" in cause && cause.code === code;

async function readRuntime(runtimeFile: string): Promise<PersistedServerRuntimeState | undefined> {
  try {
    return decodeRuntime(await NodeFSP.readFile(runtimeFile, "utf8"));
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw new Error("The saved Mines host state could not be validated.", { cause });
  }
}

async function validateRuntime(baseDir: string, version: string): Promise<void> {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  const entryPath = NodePath.join(versionDir, "mines");
  const [entry, sentinel] = await Promise.all([
    NodeFSP.lstat(entryPath),
    NodeFSP.readFile(NodePath.join(versionDir, ".install-complete"), "utf8"),
  ]);
  if (!entry.isFile() || sentinel.trim() !== version) {
    throw new Error("The selected Mines runtime is incomplete.");
  }
  await NodeFSP.access(entryPath, NodeFS.constants.X_OK);
}

async function validateStateRuntimes(baseDir: string, state: ServiceState): Promise<void> {
  await validateRuntime(baseDir, state.activeVersion);
  if (state.update?.status === "pending") {
    await validateRuntime(baseDir, state.update.targetVersion);
  }
}

async function requireStoppedHost(baseDir: string): Promise<void> {
  const runtime = await readRuntime(NodePath.join(baseDir, "userdata", "server-runtime.json"));
  if (runtime !== undefined && isProcessAlive(runtime.pid)) {
    throw new Error("A Mines host is already running; its launcher state was left unchanged.");
  }
}

export async function prepareSshLauncher(baseDir: string, version: string): Promise<void> {
  if (!NodePath.isAbsolute(baseDir) || !isExactServiceVersion(version)) {
    throw new Error(
      "SSH launcher preparation requires an absolute home and an exact Mines version.",
    );
  }
  await requireStoppedHost(baseDir);
  await validateRuntime(baseDir, version);
  const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
  const existingState = await readServiceState(statePath).catch((cause: unknown) => {
    if (hasCode(cause, "ENOENT")) return undefined;
    throw cause;
  });
  if (existingState !== undefined) {
    await validateStateRuntimes(baseDir, existingState);
    return;
  }
  const candidate = `${statePath}.ssh-${NodeCrypto.randomUUID()}`;
  try {
    await writeServiceState(candidate, {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: version,
    });
    await requireStoppedHost(baseDir);
    try {
      // A concurrent SSH bootstrap must never overwrite another launcher's selection.
      await NodeFSP.link(candidate, statePath);
    } catch (cause) {
      if (!hasCode(cause, "EEXIST")) throw cause;
      await validateStateRuntimes(baseDir, await readServiceState(statePath));
    }
  } finally {
    await NodeFSP.rm(candidate, { force: true });
  }
}

export async function runtimeOwnedByLauncher(
  runtimeFile: string,
  launcherPid: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0) return false;
  try {
    const runtime = await readRuntime(runtimeFile);
    if (runtime === undefined || !isProcessAlive(runtime.pid) || !isProcessAlive(launcherPid)) {
      return false;
    }
    const { stdout } = await execFile("ps", ["-o", "ppid=", "-p", String(runtime.pid)], {
      encoding: "utf8",
    });
    return /^\d+$/.test(stdout.trim()) && Number(stdout.trim()) === launcherPid;
  } catch {
    return false;
  }
}
