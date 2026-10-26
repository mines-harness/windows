import { resolveCliReleaseBaseUrl } from "@t3tools/shared/cliRelease";
import type { RemoteMinesRunnerOptions } from "@t3tools/ssh/tunnel";

declare const __MINES_BUILD_CLI_RELEASE_BASE_URL__: string | undefined;
declare const __MINES_BUILD_CLI_UPDATE_REPOSITORY__: string | undefined;

const buildReleaseSource = {
  MINES_CLI_RELEASE_BASE_URL:
    typeof __MINES_BUILD_CLI_RELEASE_BASE_URL__ === "undefined"
      ? undefined
      : __MINES_BUILD_CLI_RELEASE_BASE_URL__,
  MINES_CLI_UPDATE_REPOSITORY:
    typeof __MINES_BUILD_CLI_UPDATE_REPOSITORY__ === "undefined"
      ? undefined
      : __MINES_BUILD_CLI_UPDATE_REPOSITORY__,
};

type ReleaseEnvironment = Readonly<Record<string, string | undefined>>;

const hasReleaseSource = (environment: ReleaseEnvironment) =>
  Boolean(
    environment.MINES_CLI_RELEASE_BASE_URL?.trim() ||
    environment.MINES_CLI_UPDATE_REPOSITORY?.trim(),
  );

export function resolveDesktopSshCliRunner(
  input: {
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly devRemoteEntryPath?: string | undefined;
    readonly nodeEngineRange: string;
  },
  runtimeEnvironment: ReleaseEnvironment,
  buildEnvironment: ReleaseEnvironment = buildReleaseSource,
): RemoteMinesRunnerOptions {
  if (input.isDevelopment && input.devRemoteEntryPath !== undefined) {
    return { nodeScriptPath: input.devRemoteEntryPath, nodeEngineRange: input.nodeEngineRange };
  }
  const source = hasReleaseSource(runtimeEnvironment)
    ? runtimeEnvironment
    : hasReleaseSource(buildEnvironment)
      ? buildEnvironment
      : { MINES_CLI_UPDATE_REPOSITORY: "mines-harness/cli" };
  const releaseBaseUrl = resolveCliReleaseBaseUrl(
    source.MINES_CLI_RELEASE_BASE_URL,
    source.MINES_CLI_UPDATE_REPOSITORY,
  );
  return {
    archiveVersion: input.appVersion,
    ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
  };
}
