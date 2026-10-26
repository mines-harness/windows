import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_REPOSITORY_ENV,
  cliReleaseIndexPageUrl,
  resolveCliReleaseBaseUrl,
} from "@t3tools/shared/cliRelease";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
    environment[CLI_RELEASE_BASE_URL_ENV]?.trim() ||
    environment[CLI_RELEASE_REPOSITORY_ENV]?.trim(),
  );

export function resolveCliReleaseSource(
  environment: ReleaseEnvironment,
  buildEnvironment: ReleaseEnvironment = buildReleaseSource,
) {
  const source = hasReleaseSource(environment)
    ? environment
    : hasReleaseSource(buildEnvironment)
      ? buildEnvironment
      : { [CLI_RELEASE_REPOSITORY_ENV]: "mines-harness/cli" };
  const releaseBaseUrl = resolveCliReleaseBaseUrl(
    source[CLI_RELEASE_BASE_URL_ENV],
    source[CLI_RELEASE_REPOSITORY_ENV],
  );
  const repository = source[CLI_RELEASE_REPOSITORY_ENV]?.trim();
  return {
    releaseBaseUrl,
    repository:
      releaseBaseUrl !== undefined && cliReleaseIndexPageUrl(1, repository) !== undefined
        ? repository
        : undefined,
  };
}

export const cliReleaseSourceConfig = Effect.fn("cloud.cli_release_source.config")(function* () {
  const baseUrl = yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option);
  const repository = yield* Config.String(CLI_RELEASE_REPOSITORY_ENV).pipe(Config.option);
  return resolveCliReleaseSource({
    [CLI_RELEASE_BASE_URL_ENV]: Option.getOrUndefined(baseUrl),
    [CLI_RELEASE_REPOSITORY_ENV]: Option.getOrUndefined(repository),
  });
});
