import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { environmentCatalog } from "../../connection/catalog";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { APP_VERSION } from "../../branding";
import { type EnvironmentPresentation } from "../../state/environments";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { EllipsisIcon } from "lucide-react";
import { OutdatedServerUpdateAction } from "../ServerUpdateAction";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import {
  ConnectionDiagnosisPanel,
  ConnectionDiagnosisSummary,
  useConnectionDiagnosis,
} from "./ConnectionDiagnosisDetails";
import { AuthorizedClientsSettings } from "./AuthorizedClientsSettings";
import { SessionPermissions } from "./SessionPermissions";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { GroupHostRoutesSettings } from "./GroupHostRoutesSettings";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { MinesPeerClientSettings } from "./MinesPeerClientSettings";
import { MinesPeerSettings } from "./MinesPeerSettings";

export function ConnectionsAdvancedSettings() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironment();
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (environmentId: EnvironmentId, enabled: boolean) => {
    setPending(environmentId);
    setError(null);
    const result = await setEnabled({ environmentId, enabled });
    if (result._tag !== "Success") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The device could not be updated.");
    }
    setPending(null);
  };
  return (
    <div className="space-y-8">
      <SettingsSection id="connections-environment" title="Your computers">
        <LocalEnvironmentSetting />
        {environments.map((environment) => (
          <ComputerSettingsRow
            key={environment.environmentId}
            environment={environment}
            title={environment.label}
            description={
              environment.connection.phase === "connected"
                ? environment.environmentId === primary?.environmentId
                  ? "Connected · current workspace"
                  : "Connected"
                : environment.connection.phase === "unsupported"
                  ? environment.connection.error
                  : environment.entry.enabled
                    ? `Connection: ${environment.connection.phase}. Retry from the device selector.`
                    : "Disabled. Its conversations stay in their saved sidebar positions."
            }
            control={
              <>
                {environment.environmentId !== primary?.environmentId ? (
                  <Switch
                    aria-label={`Enable ${environment.label}`}
                    checked={environment.entry.enabled}
                    disabled={pending !== null}
                    onCheckedChange={(enabled) => void toggle(environment.environmentId, enabled)}
                  />
                ) : null}
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Options for ${environment.label}`}
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup>
                    <EnvironmentIconMenu
                      environmentId={environment.environmentId}
                      serverConfig={environment.serverConfig}
                    />
                  </MenuPopup>
                </Menu>
              </>
            }
          />
        ))}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      <MinesPeerSettings />
      <MinesPeerClientSettings />
      <GroupHostRoutesSettings />
      <AuthorizedClientsSettings />
      <PullRequestRoutingSettings environments={environments} />
    </div>
  );
}

function ComputerSettingsRow({
  environment,
  title,
  description,
  control,
}: {
  readonly environment: EnvironmentPresentation;
  readonly title: string;
  readonly description: string | null;
  readonly control: React.ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const { diagnosis, state } = useConnectionDiagnosis(environment);
  const retry = useAtomCommand(environmentCatalog.retryNow);
  return (
    <div>
      <SettingsRow title={title} description={description} control={control} />
      {diagnosis ? (
        <div className="px-3 pb-3">
          <ConnectionDiagnosisSummary
            diagnosis={diagnosis}
            retryAt={state.retryAt}
            attempt={state.attempt}
            expanded={details}
            onToggle={() => setDetails(!details)}
          />
          {details ? (
            <ConnectionDiagnosisPanel
              hostLabel={environment.label}
              diagnosis={diagnosis}
              onRetry={() => void retry(environment.environmentId)}
              onAddRoute={null}
            />
          ) : null}
        </div>
      ) : null}
      {environment.connection.phase === "unsupported" &&
      environment.entry.serverUpdateRequired === true ? (
        <OutdatedServerUpdateAction
          environmentId={environment.environmentId}
          serverLabel={environment.label}
          fromVersion={undefined}
          targetVersion={APP_VERSION}
        />
      ) : null}
      <div className="px-3 pb-2">
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => setPermissions(!permissions)}
          aria-expanded={permissions}
        >
          Connection permissions
        </Button>
        {permissions ? (
          <SessionPermissions
            environmentId={environment.environmentId}
            connected={environment.connection.phase === "connected"}
          />
        ) : null}
      </div>
    </div>
  );
}
