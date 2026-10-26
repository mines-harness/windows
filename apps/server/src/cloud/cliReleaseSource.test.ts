import { describe, expect, it } from "vite-plus/test";

import { resolveCliReleaseSource } from "./cliReleaseSource.ts";

describe("Mines CLI release source", () => {
  it("uses the Mines distribution when no source is configured", () => {
    expect(resolveCliReleaseSource({}, {})).toEqual({
      releaseBaseUrl: "https://github.com/mines-harness/cli/releases/download",
      repository: "mines-harness/cli",
    });
  });

  it("selects one complete source instead of mixing runtime and bundled settings", () => {
    const bundled = { MINES_CLI_UPDATE_REPOSITORY: "example/fork" };
    expect(resolveCliReleaseSource({}, bundled)).toEqual({
      releaseBaseUrl: "https://github.com/example/fork/releases/download",
      repository: "example/fork",
    });
    expect(
      resolveCliReleaseSource(
        { MINES_CLI_RELEASE_BASE_URL: "https://releases.example/download/" },
        bundled,
      ),
    ).toEqual({ releaseBaseUrl: "https://releases.example/download", repository: undefined });
  });

  it("does not fall back to a different release after rejecting an explicit source", () => {
    for (const environment of [
      { MINES_CLI_UPDATE_REPOSITORY: "pingdotgg/t3code" },
      { MINES_CLI_UPDATE_REPOSITORY: "invalid/repo/path" },
      { MINES_CLI_RELEASE_BASE_URL: "http://releases.example/download" },
      { MINES_CLI_RELEASE_BASE_URL: "https://user:password@releases.example/download" },
      {
        MINES_CLI_RELEASE_BASE_URL: "https://github.com/pingdotgg/t3code/releases/download",
        MINES_CLI_UPDATE_REPOSITORY: "mines-harness/cli",
      },
    ]) {
      expect(resolveCliReleaseSource(environment, {})).toEqual({
        releaseBaseUrl: undefined,
        repository: undefined,
      });
    }
    expect(
      resolveCliReleaseSource({}, { MINES_CLI_UPDATE_REPOSITORY: "pingdotgg/t3code" }),
    ).toEqual({
      releaseBaseUrl: undefined,
      repository: undefined,
    });
  });
});
