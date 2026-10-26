import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes } from "@t3tools/client-runtime/connection";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

import { APP_VERSION } from "../../branding";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  resolveServerSelfUpdateCapability,
  supportsServerUpdateThreadContinuation,
} from "../../versionSkew";
import {
  OutdatedServerUpdateAction,
  ServerUpdateAction,
  ServerUpdateProgress,
} from "../ServerUpdateAction";

export function DeviceCliUpdateAction({
  environment,
  targetVersion = APP_VERSION,
}: {
  readonly environment: EnvironmentPresentation;
  readonly targetVersion?: string;
}) {
  const state = useAtomValue(serverEnvironment.updateStateAtom(environment.environmentId));
  if (
    !connectionRoutes(environment.entry).some(
      (route) => route.target._tag === "SshConnectionTarget",
    )
  ) {
    return null;
  }
  if (state.status !== "idle") return <ServerUpdateProgress state={state} />;
  if (environment.entry.serverUpdateRequired && environment.connection.phase === "unsupported") {
    return (
      <OutdatedServerUpdateAction
        environmentId={environment.environmentId}
        serverLabel={environment.label}
        fromVersion={undefined}
        targetVersion={targetVersion}
        label="Update CLI"
      />
    );
  }
  const config = environment.serverConfig;
  const installedVersion = config?.environment.serverVersion;
  if (
    environment.connection.phase !== "connected" ||
    config === null ||
    installedVersion === undefined ||
    parseSemver(installedVersion) === null ||
    parseSemver(targetVersion) === null ||
    compareSemverVersions(installedVersion, targetVersion) >= 0
  ) {
    return null;
  }
  const selfUpdate = resolveServerSelfUpdateCapability(config);
  if (selfUpdate === null || selfUpdate === "desktop-managed") {
    return (
      <span className="text-xs text-muted-foreground">
        Run <code>mines service install</code> on this computer to enable CLI updates.
      </span>
    );
  }
  return (
    <ServerUpdateAction
      environmentId={environment.environmentId}
      serverLabel={environment.label}
      selfUpdate={selfUpdate}
      threadContinuation={supportsServerUpdateThreadContinuation(config)}
      targetVersion={targetVersion}
      label="Update CLI"
      size="xs"
    />
  );
}
