import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopSshCliRunner } from "./DesktopSshCliRunner.ts";

const packaged = {
  isDevelopment: false,
  appVersion: "0.1.12",
  nodeEngineRange: ">=24",
};

describe("desktop SSH CLI runner", () => {
  it("installs the app's exact Mines release when launched without a shell environment", () => {
    expect(resolveDesktopSshCliRunner(packaged, {}, {})).toEqual({
      archiveVersion: "0.1.12",
      releaseBaseUrl: "https://github.com/mines-harness/cli/releases/download",
    });
  });

  it("prefers an explicit runtime source over the source bundled into the app", () => {
    expect(
      resolveDesktopSshCliRunner(
        packaged,
        { MINES_CLI_UPDATE_REPOSITORY: "example/fork" },
        { MINES_CLI_RELEASE_BASE_URL: "https://releases.example/download" },
      ),
    ).toEqual({
      archiveVersion: "0.1.12",
      releaseBaseUrl: "https://github.com/example/fork/releases/download",
    });
    expect(
      resolveDesktopSshCliRunner(
        packaged,
        {},
        { MINES_CLI_RELEASE_BASE_URL: "https://releases.example/download/" },
      ).releaseBaseUrl,
    ).toBe("https://releases.example/download");
  });

  it("fails closed for invalid explicit sources rather than downloading a different build", () => {
    for (const MINES_CLI_RELEASE_BASE_URL of [
      "https://github.com/pingdotgg/t3code/releases/download",
      "http://releases.example/download",
      "https://user:password@releases.example/download",
    ]) {
      expect(resolveDesktopSshCliRunner(packaged, { MINES_CLI_RELEASE_BASE_URL }, {})).toEqual({
        archiveVersion: "0.1.12",
      });
    }
    expect(
      resolveDesktopSshCliRunner(packaged, {}, { MINES_CLI_UPDATE_REPOSITORY: "pingdotgg/t3code" }),
    ).toEqual({ archiveVersion: "0.1.12" });
  });

  it("uses a source runner only for development", () => {
    const input = { ...packaged, devRemoteEntryPath: "/work/mines/apps/server/src/bin.ts" };
    expect(resolveDesktopSshCliRunner({ ...input, isDevelopment: true }, {}, {})).toEqual({
      nodeScriptPath: input.devRemoteEntryPath,
      nodeEngineRange: ">=24",
    });
    expect(resolveDesktopSshCliRunner(input, {}, {}).archiveVersion).toBe("0.1.12");
  });
});
