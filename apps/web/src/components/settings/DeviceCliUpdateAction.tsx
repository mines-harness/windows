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
  ServerVersionInfo,
} from "../ServerUpdateAction";

export function DeviceCliUpdateAction({
  environment,
  targetVersion = APP_VERSION,
}: {
  readonly environment: EnvironmentPresentation;
  readonly targetVersion?: string;
}) {
  const state = useAtomValue(serverEnvironment.updateStateAtom(environment.environmentId));
  if (state.status === "running") return <ServerUpdateProgress state={state} />;
  const action = <DeviceVersionAction environment={environment} targetVersion={targetVersion} />;
  return state.status === "failed" ? (
    <div className="flex flex-wrap items-center gap-2">
      <ServerUpdateProgress state={state} />
      {action}
    </div>
  ) : (
    action
  );
}

function DeviceVersionAction({
  environment,
  targetVersion,
}: {
  readonly environment: EnvironmentPresentation;
  readonly targetVersion: string;
}) {
  const ssh = connectionRoutes(environment.entry).some(
    (route) => route.target._tag === "SshConnectionTarget",
  );
  if (
    ssh &&
    environment.entry.serverUpdateRequired &&
    environment.connection.phase === "unsupported"
  ) {
    return (
      <OutdatedServerUpdateAction
        environmentId={environment.environmentId}
        serverLabel={environment.label}
        fromVersion={undefined}
        targetVersion={targetVersion}
        label="Update CLI"
        appearance="icon"
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
    parseSemver(targetVersion) === null
  ) {
    return null;
  }
  if (compareSemverVersions(installedVersion, targetVersion) >= 0) {
    return <ServerVersionInfo version={installedVersion} serverLabel={environment.label} />;
  }
  if (!ssh) return null;
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
      appearance="icon"
    />
  );
}
