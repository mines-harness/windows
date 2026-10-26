import { useAtomValue } from "@effect/atom-react";
import type {
  AgentSessionScanInput,
  AgentSessionSource,
  ProviderInstanceId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  AuthProvidersManageScope,
  EnvironmentId,
  ProjectId,
  CommandId,
  defaultInstanceIdForDriver,
  AuthOrchestrationOperateScope,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ArrowRightIcon, CheckIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingProjectId,
  updateImportSelection,
  importSelectionCounts,
  type ImportSelection,
} from "../../onboarding/projectImport.logic";
import {
  getOnboardingProviderState,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { newProjectId, randomUUID } from "../../lib/utils";
import { backgroundImports } from "../../state/backgroundImports";
import { backgroundImportCompletionNotice } from "../../onboarding/backgroundImports.logic";
import { readProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import {
  isOnboardingRelayEnvironment,
  resolveOnboardingSetup,
} from "../../onboarding/targetEnvironment.logic";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { importIssueReports, importSourceLabel } from "../../onboarding/importIssues.logic";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { getProviderSummary } from "../settings/providerStatus";
import { searchOnboardingProviders } from "../../onboarding/providerSearch.logic";
import { AddProviderInstanceDialog } from "../settings/AddProviderInstanceDialog";
import { ProviderWizardAuthenticationStep } from "../settings/ProviderWizardAuthenticationStep";
import { providerClients } from "../settings/providerDriverMeta";
import { ChatGptWelcomeCoordinator } from "../settings/ChatGptWelcomeCoordinator";
import { AddManagedCodexAccountDialog, CodexSetupSection } from "../settings/CodexSetupSection";
import { readCodexSetupMode } from "../settings/CodexSetupSection.logic";
import { buildProviderInstanceUpdatePatch } from "../settings/SettingsPanels.logic";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { presentSavedCloudEnvironmentConnection } from "../cloud/cloudEnvironmentConnectionPresentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { MinesPhoneSetupPanel } from "./MinesPhoneSetupPanel";
import { MinesIdentityCard } from "./MinesIdentityCard";
import { ImportProjectPreview } from "./ImportProjectPreview";
import { minesAccountIdAtom } from "@t3tools/client-runtime/catalog";
import { MinesWordmark } from "../MinesWordmark";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { WizardPanel, WizardSteps, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";

const WizardProgress = Schema.Struct({
  step: Schema.Literals(["connection", "agents", "import", "phone"]),
  environmentIds: Schema.Array(EnvironmentId),
  projectRef: Schema.optional(
    Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId }),
  ),
  importWarning: Schema.optional(Schema.String),
  importedThreadCount: Schema.optional(Schema.Number),
});
type WizardStep = (typeof WizardProgress.Type)["step"];
const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const ONBOARDING_STAGES = ["Your devices", "Your agents", "Your work", "Your phone"] as const;
const SCAN_LIMIT_MESSAGE = "Scan limit reached. Some projects or conversations may be missing.";

export function WelcomeWizard({
  localAvailable,
  onDone,
  resumeEnvironmentId,
}: {
  readonly localAvailable: boolean;
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const [progress, setProgress] = useLocalStorage(
    "mines:onboarding:v1",
    {
      step: "connection",
      environmentIds: [],
    } as typeof WizardProgress.Type,
    WizardProgress,
  );
  const [step, setStepState] = useState<WizardStep>(resumeEnvironmentId ? "agents" : progress.step);
  const setStep = (next: WizardStep) => {
    setStepState(next);
    setProgress((current) => ({ ...current, step: next }));
  };
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  // Share the registry for the wizard's lifetime so unchecked computers are not auto-selected again.
  const [autoSelectedComputers] = useState(() => new Set<EnvironmentId>());
  const [setupIds, setSetupIdsState] = useState<readonly EnvironmentId[]>(
    resumeEnvironmentId ? [resumeEnvironmentId] : progress.environmentIds,
  );
  const setSetupIds = (environmentIds: readonly EnvironmentId[]) => {
    setSetupIdsState(environmentIds);
    setProgress((current) => ({ ...current, environmentIds }));
  };
  const [isImporting, setIsImporting] = useState(false);
  const [importOptions, setImportOptions] = useState<AgentSessionScanInput>({
    sources: ["codex", "claudeAgent", "opencode", "antigravity", "t3code"],
  });
  const [knownHistorySources] = useState(() => new Set<AgentSessionSource>());
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.add(environment.environmentId);
    }
    const enabledComputers = newComputers.filter((environment) => environment.entry.enabled);
    if (enabledComputers.length === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- The registry marks each computer once, and only after commit; render must not mutate it.
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...enabledComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [autoSelectedComputers, environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const scans = useProjectScans(step === "import" ? setupIds : NO_ENVIRONMENTS, importOptions);
  const isLoadingProjects =
    step === "import" &&
    scans.every((scan) => scan.data === null) &&
    scans.some((scan) => scan.isPending);
  const startSetup = (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setStep("agents");
  };
  const stageIndex = step === "phone" ? 3 : step === "import" ? 2 : step === "agents" ? 1 : 0;
  const finish = (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount = 0,
  ) => {
    if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }

    const completion = completeOnboarding()
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        await onDone(projectRef);
        setProgress({ step: "connection", environmentIds: [] });
        if (importWarning) {
          const notice = backgroundImportCompletionNotice(backgroundImports.getSnapshot());
          if (notice)
            toastManager.add({ ...notice, timeout: notice.type === "warning" ? 0 : 5000 });
        } else if (importedThreadCount > 0) {
          toastManager.add({
            type: "success",
            title: `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "mine" : "mines"}`,
          });
        }
        return true;
      })
      .catch(() => {
        const errorToast = {
          type: "error",
          title: "Could not finish setup",
          description: "Your settings could not be saved. Try again.",
        } as const;
        if (completionErrorToastIdRef.current === null) {
          completionErrorToastIdRef.current = toastManager.add(errorToast);
        } else {
          toastManager.update(completionErrorToastIdRef.current, errorToast);
        }
        return false;
      })
      .finally(() => {
        if (finishingPromiseRef.current === completion) {
          finishingPromiseRef.current = null;
        }
      });
    finishingPromiseRef.current = completion;
    return completion;
  };

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(_, event) => {
        event.cancel();
        if (event.reason === "close-press" && !isImporting)
          void finish(progress.projectRef, progress.importWarning, progress.importedThreadCount);
      }}
    >
      <WizardPopup
        size="wide"
        bottomStickOnMobile={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <WizardHeader
          title="Make room for your next idea"
          identity={
            <div className="flex items-baseline gap-1.5" role="img" aria-label="mines">
              <MinesWordmark className="h-8 w-auto shrink-0" aria-hidden />
            </div>
          }
        >
          <WizardSteps
            steps={ONBOARDING_STAGES}
            currentStep={stageIndex}
            isStepDisabled={(index) => isImporting || index >= stageIndex}
            onStepChange={(index) => {
              if (isImporting || index > stageIndex) return;
              setStep(index === 0 ? "connection" : index === 1 ? "agents" : "import");
            }}
          />
        </WizardHeader>

        <WizardPanel holdHeight={isLoadingProjects}>
          {step === "connection" ? (
            <ConnectionStep
              localAvailable={localAvailable}
              currentEnvironmentId={primaryEnvironment?.environmentId ?? null}
              selectedIds={selectedIds}
              onSelectionChange={setSelection}
              onContinue={() =>
                startSetup(
                  resolveOnboardingSetup(
                    environments,
                    selectedIds,
                    primaryEnvironment?.environmentId,
                  ).environmentIds,
                )
              }
            />
          ) : step === "agents" ? (
            <AgentsStep environmentIds={setupIds} onContinue={() => setStep("import")} />
          ) : step === "phone" ? (
            <MinesPhoneSetupPanel
              onDone={() => {
                void finish(
                  progress.projectRef,
                  progress.importWarning,
                  progress.importedThreadCount,
                );
              }}
            />
          ) : (
            <ImportStep
              options={importOptions}
              knownHistorySources={knownHistorySources}
              setOptions={setImportOptions}
              scans={scans}
              isImporting={isImporting}
              setIsImporting={setIsImporting}
              onDone={async (projectRef, importWarning, importedThreadCount) => {
                setProgress((current) => ({
                  ...current,
                  ...(projectRef ? { projectRef } : {}),
                  ...(importWarning ? { importWarning } : {}),
                  importedThreadCount: importedThreadCount ?? 0,
                }));
                setStep("phone");
                return true;
              }}
            />
          )}
        </WizardPanel>
      </WizardPopup>
      <ChatGptWelcomeCoordinator />
    </Dialog>
  );
}

function ConnectionStep({
  localAvailable,
  currentEnvironmentId,
  selectedIds,
  onSelectionChange,
  onContinue,
}: {
  readonly localAvailable: boolean;
  readonly currentEnvironmentId: EnvironmentId | null;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onContinue: () => void;
}) {
  const { environments } = useEnvironments();
  const directEnvironments = environments.filter(
    (environment) =>
      environment.environmentId !== currentEnvironmentId &&
      !isOnboardingRelayEnvironment(environment),
  );
  const { ready, skippedIds } = resolveOnboardingSetup(
    environments,
    selectedIds,
    currentEnvironmentId,
  );
  const skippedLabels = environments
    .filter((environment) => skippedIds.includes(environment.environmentId))
    .map((environment) => environment.label);
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Your work, wherever you are
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Start on this computer. Add any other devices, then bring your agents and existing work into
        mines.
      </p>
      <MinesIdentityCard />
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Other computers to set up</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {environment.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {!environment.entry.enabled && environment.connection.phase !== "unsupported"
                      ? "Off"
                      : presentSavedCloudEnvironmentConnection(environment.connection).buttonLabel}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
                {environment.connection.phase === "unsupported" && environment.connection.error ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {environment.connection.error}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {!localAvailable && directEnvironments.length === 0 ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Open mines on your computer to begin. You can approve and pair your phone in the final
          setup step.
        </p>
      ) : null}
      {skippedLabels.length > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Not connected, so setup skips {skippedLabels.join(", ")}. You can set{" "}
          {skippedLabels.length === 1 ? "it" : "them"} up later from Settings.
        </p>
      ) : null}
      <div className="mt-6 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
          Provider credentials stay on the computer that runs them. Phone access is optional and can
          be set up after your first task.
        </p>
        <Button
          className="shrink-0 self-end"
          ref={continueRef}
          autoFocus
          disabled={!ready}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

const PRIMARY_AGENT_DRIVERS = ["codex", "claudeAgent"] as const;
type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

function AgentsStep({
  environmentIds,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onContinue: () => void;
}) {
  const { environments } = useEnvironments();
  const [query, setQuery] = useState("");
  return (
    <StepShell
      title="Connect your agents"
      description="Choose an agent to start coding. You can add more later."
    >
      <div className="mt-4">
        <Input
          aria-label="Search providers"
          placeholder="Search providers…"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(32rem,55dvh)]">
        <div className="space-y-5 pr-3">
          {environmentIds.map((environmentId) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              query={query}
              machineLabel={
                environments.find((environment) => environment.environmentId === environmentId)
                  ?.label ?? "Computer"
              }
            />
          ))}
        </div>
      </ScrollArea>
      <div className="mt-6 flex justify-end">
        <Button autoFocus onClick={onContinue}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
  query,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly query: string;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const attemptedAccounts = useRef(new Set<ProviderInstanceId>());
  const [accountErrors, setAccountErrors] = useState<Readonly<Record<string, string>>>({});
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<{
    instanceId: ProviderInstanceId;
    displayName: string;
    autoStart: boolean;
  } | null>(null);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [providerSetup, setProviderSetup] = useState<{
    driver: ProviderDriverKind;
    instanceId?: ProviderInstanceId;
    query?: string;
  } | null>(null);
  const definitions = searchOnboardingProviders(providerClients.definitions, query);
  const matchingDrivers = new Set(definitions.map((definition) => definition.driverKind));
  const additionalProviders = definitions.filter(
    (definition) => !["codex", "claudeAgent", "acpRegistry"].includes(definition.driverKind),
  );

  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  useEffect(() => {
    if (!canManageProviders || !serverConfig) return;
    const accounts = (providers ?? []).filter(
      (provider) =>
        !provider.enabled &&
        serverConfig.settings.providerInstances[provider.instanceId]?.removed !== true &&
        provider.installed &&
        provider.auth.status === "authenticated" &&
        accountErrors[provider.instanceId] === undefined &&
        !attemptedAccounts.current.has(provider.instanceId),
    );
    if (accounts.length === 0) return;
    for (const provider of accounts) attemptedAccounts.current.add(provider.instanceId);
    void (async () => {
      await Promise.all(
        accounts.map(async (provider) => {
          try {
            if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
            const instance = serverConfig.settings.providerInstances[provider.instanceId] ?? {
              driver: provider.driver,
              config: {},
            };
            const config = instance.config;
            const result = await persistProviderInstance({
              operation: "upsert",
              instanceId: provider.instanceId,
              instance: {
                ...instance,
                enabled: true,
                ...(config !== null &&
                typeof config === "object" &&
                !Array.isArray(config) &&
                "enabled" in config
                  ? { config: { ...config, enabled: true } }
                  : {}),
              },
            });
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
          } catch (cause) {
            const message =
              cause instanceof Error ? cause.message : "Could not connect this account.";
            setAccountErrors((current) => ({ ...current, [provider.instanceId]: message }));
            toastManager.add({
              type: "error",
              title: "Could not connect saved account",
              description: message,
            });
          }
        }),
      );
      await refreshProviders({ environmentId, input: {} });
    })();
  }, [
    accountErrors,
    canManageProviders,
    environmentId,
    persistProviderInstance,
    providers,
    refreshProviders,
    serverConfig,
  ]);

  const byDriver = selectOnboardingProvidersByDriver(providers);

  const primaryAgents = PRIMARY_AGENT_DRIVERS.flatMap((driver) => {
    const instances =
      driver === "codex" ? providers?.filter((provider) => provider.driver === driver) : undefined;
    return instances?.length
      ? instances.map((provider) => ({ driver, provider, instanceId: provider.instanceId }))
      : [{ driver, provider: byDriver.get(driver), instanceId: byDriver.get(driver)?.instanceId }];
  });
  if (createdAccount) {
    const index = primaryAgents.findIndex(
      (agent) => agent.instanceId === createdAccount.instanceId,
    );
    const [existing] = index >= 0 ? primaryAgents.splice(index, 1) : [];
    primaryAgents.unshift(
      existing ?? {
        driver: "codex",
        provider: undefined,
        instanceId: createdAccount.instanceId,
      },
    );
  }
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>
      {!canManageProviders ? (
        <p className="mb-2 text-sm text-muted-foreground">
          This connection cannot manage providers.
        </p>
      ) : !canOperateTerminal ? (
        <p className="mb-2 text-sm text-muted-foreground">
          This connection cannot control terminals.
        </p>
      ) : null}
      <div className="space-y-1.5" inert={!canManageProviders}>
        {primaryAgents
          .filter(({ driver }) => matchingDrivers.has(ProviderDriverKind.make(driver)))
          .map(({ driver, provider, instanceId }) =>
            driver === "codex" && serverConfig !== null ? (
              <OnboardingCodexSetup
                key={instanceId ?? driver}
                environmentId={environmentId}
                provider={provider}
                serverConfig={serverConfig}
                createdAccount={instanceId === createdAccount?.instanceId ? createdAccount : null}
                onAutoStartConsumed={() =>
                  setCreatedAccount((account) =>
                    account ? { ...account, autoStart: false } : null,
                  )
                }
                terminalOpen={terminalSession?.driver === driver}
                onOpenTerminal={() => {
                  if (
                    provider === undefined ||
                    !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
                    !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
                  )
                    return;
                  setTerminalSession({
                    environmentId,
                    driver,
                    providerInstanceId: provider.instanceId,
                    cwd: serverConfig.cwd,
                    command: provider.installed
                      ? resolveOnboardingProviderLoginCommand(
                          provider,
                          serverConfig.settings,
                          serverConfig.environment.platform.os,
                        )
                      : resolveOnboardingProviderInstallCommand(
                          driver,
                          serverConfig.environment.platform.os,
                        ),
                    keybindings: serverConfig.keybindings,
                  });
                }}
              />
            ) : (
              <AgentCard
                key={driver}
                driver={driver}
                provider={provider}
                terminalOpen={terminalSession?.driver === driver}
                terminalAvailable={
                  serverConfig !== null && canOperateTerminal && canManageProviders
                }
                onOpenTerminal={() => {
                  if (
                    provider === undefined ||
                    serverConfig === null ||
                    !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
                    !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
                  )
                    return;
                  setTerminalSession({
                    environmentId,
                    driver,
                    providerInstanceId: provider.instanceId,
                    cwd: serverConfig.cwd,
                    command: provider.installed
                      ? resolveOnboardingProviderLoginCommand(
                          provider,
                          serverConfig.settings,
                          serverConfig.environment.platform.os,
                        )
                      : resolveOnboardingProviderInstallCommand(
                          driver,
                          serverConfig.environment.platform.os,
                        ),
                    keybindings: serverConfig.keybindings,
                  });
                }}
              />
            ),
          )}
      </div>
      <div className="mt-3 space-y-1">
        {additionalProviders.map((definition) => {
          const provider = byDriver.get(definition.driverKind);
          const savedAccount =
            !provider?.enabled && provider?.installed && provider?.auth.status === "authenticated";
          const ready = getOnboardingProviderState(provider) === "ready";
          const accountError = savedAccount ? accountErrors[provider.instanceId] : undefined;
          return (
            <div
              key={definition.driverKind}
              className="flex items-center gap-3 rounded-lg px-3 py-2"
            >
              <ProviderInstanceIcon
                driverKind={definition.driverKind}
                displayName={definition.label}
                iconClassName="size-4"
              />
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{definition.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {accountError ??
                    (ready
                      ? "Ready to code."
                      : savedAccount
                        ? `Account detected${provider.auth.label ? ` · ${provider.auth.label}` : ""}`
                        : definition.driverKind === "antigravity"
                          ? "Gemini · Google account"
                          : provider?.enabled
                            ? getProviderSummary(provider).headline
                            : "Connect an account or configure this agent")}
                </span>
              </div>
              {ready ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                  <CheckIcon className="size-3.5" /> Ready
                </span>
              ) : savedAccount && !accountError ? (
                <span className="text-xs text-muted-foreground">Connecting…</span>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={
                    accountError
                      ? `Retry ${definition.label} account`
                      : `Set up ${definition.label}`
                  }
                  disabled={!canManageProviders}
                  onClick={() => {
                    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
                    if (accountError && provider) {
                      attemptedAccounts.current.delete(provider.instanceId);
                      setAccountErrors((current) => {
                        const next = { ...current };
                        delete next[provider.instanceId];
                        return next;
                      });
                      return;
                    }
                    setProviderSetup({
                      driver: definition.driverKind,
                      ...(provider?.enabled ? { instanceId: provider?.instanceId } : {}),
                    });
                  }}
                >
                  {accountError ? "Retry" : "Set up"}
                </Button>
              )}
            </div>
          );
        })}
        {!definitions.some((definition) => definition.driverKind !== "acpRegistry") ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No matching provider. Browse more integrations below.
          </p>
        ) : null}
        <div className="flex items-center gap-3 rounded-lg px-3 py-2">
          <ProviderInstanceIcon
            driverKind={ProviderDriverKind.make("acpRegistry")}
            displayName="More providers"
            iconClassName="size-4"
          />
          <div className="min-w-0 flex-1">
            <span className="block text-sm font-medium">More providers</span>
            <span className="block text-xs text-muted-foreground">
              Find more agents and local integrations
            </span>
          </div>
          <Button
            size="xs"
            variant="outline"
            aria-label="More providers"
            disabled={!canManageProviders}
            onClick={() => {
              if (readEnvironmentScope(environmentId, AuthProvidersManageScope))
                setProviderSetup({
                  driver: ProviderDriverKind.make("acpRegistry"),
                  query: query.trim(),
                });
            }}
          >
            Browse
          </Button>
        </div>
      </div>
      {providerSetup?.instanceId ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setProviderSetup(null);
          }}
        >
          <WizardPopup size="wide" fixedFooter>
            <WizardHeader
              title={`${providerClients.get(providerSetup.driver)?.label ?? "Provider"} setup`}
              description={machineLabel}
            />
            <ProviderWizardAuthenticationStep
              environmentId={environmentId}
              environmentLabel={machineLabel}
              instanceId={providerSetup.instanceId}
              driverKind={providerSetup.driver}
              onFinish={() => {
                setProviderSetup(null);
                void refreshProviders({ environmentId, input: {} });
              }}
            />
          </WizardPopup>
        </Dialog>
      ) : providerSetup ? (
        <AddProviderInstanceDialog
          key={`${providerSetup.driver}:${providerSetup.query ?? ""}`}
          open
          environmentId={environmentId}
          environmentLabel={machineLabel}
          initialDriverKind={providerSetup.driver}
          {...(providerSetup.query ? { initialSearchQuery: providerSetup.query } : {})}
          finishSetup
          onCreated={() => {
            void refreshProviders({ environmentId, input: {} });
          }}
          onOpenChange={(open) => {
            if (!open) setProviderSetup(null);
          }}
        />
      ) : null}
      {matchingDrivers.has(ProviderDriverKind.make("codex")) &&
      providers?.some(
        (provider) =>
          provider.driver === "codex" && getOnboardingProviderState(provider) === "ready",
      ) ? (
        <div className="mt-3">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canManageProviders}
            onClick={() => {
              if (readEnvironmentScope(environmentId, AuthProvidersManageScope))
                setAddingAccount(true);
            }}
          >
            Connect another ChatGPT account
          </Button>
        </div>
      ) : null}
      {addingAccount ? (
        <AddManagedCodexAccountDialog
          environmentId={environmentId}
          onClose={() => setAddingAccount(false)}
          onAccountCreated={(instanceId, displayName) =>
            setCreatedAccount({ instanceId, displayName, autoStart: true })
          }
        />
      ) : null}
      {terminalSession !== null ? (
        <AgentInstallTerminal
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.driver}`}
          session={terminalSession}
          onClose={() => {
            setTerminalSession(null);
            void refreshProviders({ environmentId, input: {} });
          }}
        />
      ) : null}
    </section>
  );
}

function OnboardingCodexSetup({
  createdAccount,
  onAutoStartConsumed,
  environmentId,
  provider,
  serverConfig,
  terminalOpen,
  onOpenTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider | undefined;
  readonly serverConfig: ServerConfig;
  readonly terminalOpen: boolean;
  readonly onOpenTerminal: () => void;
  readonly createdAccount: {
    instanceId: ProviderInstanceId;
    displayName: string;
    autoStart: boolean;
  } | null;
  readonly onAutoStartConsumed: () => void;
}) {
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, "Codex setup settings");
  const instanceId =
    createdAccount?.instanceId ??
    provider?.instanceId ??
    defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
  const settings = serverConfig.settings;
  const instance = settings.providerInstances[instanceId] ?? {
    driver: ProviderDriverKind.make("codex"),
    config: createdAccount ? { enabled: true, setupMode: "managed" } : {},
  };
  const mode = readCodexSetupMode(instance.config);
  const existingChosen =
    mode === "existing" &&
    instance.config !== null &&
    typeof instance.config === "object" &&
    "setupMode" in instance.config &&
    instance.config.setupMode === "existing";
  const changeMode = (setupMode: "managed" | "existing") => {
    void update({
      environmentId,
      input: {
        patch: buildProviderInstanceUpdatePatch({
          settings,
          instanceId,
          instance: {
            ...instance,
            enabled: true,
            config: {
              ...(instance.config !== null && typeof instance.config === "object"
                ? instance.config
                : {}),
              enabled: true,
              setupMode,
            },
          },
        }),
      },
    });
  };
  return existingChosen ? (
    <AgentCard
      driver="codex"
      provider={provider}
      terminalOpen={terminalOpen}
      terminalAvailable={canOperateTerminal}
      onOpenTerminal={onOpenTerminal}
    />
  ) : (
    <CodexSetupSection
      presentation="onboarding"
      autoStart={createdAccount?.autoStart === true}
      displayName={createdAccount?.displayName}
      onAutoStartConsumed={onAutoStartConsumed}
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      mode={mode}
      enabled={provider?.enabled ?? true}
      onModeChange={changeMode}
    />
  );
}

function AgentCard({
  driver,
  provider,
  terminalOpen,
  terminalAvailable,
  onOpenTerminal,
}: {
  readonly driver: OnboardingAgentDriver;
  readonly provider: ServerProvider | undefined;
  readonly terminalOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const meta = providerClients.get(ProviderDriverKind.make(driver));
  const displayName =
    provider?.displayName || (driver === "claudeAgent" ? "Claude Code" : (meta?.label ?? driver));
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-4">
      <ProviderInstanceIcon
        driverKind={ProviderDriverKind.make(driver)}
        displayName={displayName}
        iconClassName="size-5"
      />
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {providerState === "ready" ? "Ready to code." : summary.headline}
          {providerState !== "ready" && summary.detail ? ` · ${summary.detail}` : ""}
        </p>
      </div>
      <div className="shrink-0">
        {providerState === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : providerState === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : providerState === "disabled" ? (
          <span className="text-xs text-muted-foreground">Disabled</span>
        ) : providerState === "attention" ? (
          <span className="text-xs text-muted-foreground">{summary.headline}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={onOpenTerminal}
            disabled={terminalOpen || !terminalAvailable}
          >
            <TerminalIcon className="size-3.5" />
            {providerState === "signIn" ? "Sign in" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentInstallTerminal({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // StrictMode can finish a cancelled open after replacement setup; it must not close or pre-type into that
  // session.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    // oxlint-disable-next-line react/set-state-in-effect -- A retry or a new command reopens the terminal, which shows as preparing until the open settles.
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Revocation leaves the PTY running; close only while terminal access remains.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps setupAttempt to open the terminal again.
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal ? (
            "This connection cannot control terminals."
          ) : setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            "Review the command, then press Enter to run it."
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Install ${driver}`}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

const IMPORT_PERMISSION_MESSAGE = "This connection cannot import projects or mine history.";

function ImportStep({
  options,
  knownHistorySources,
  setOptions,
  scans,
  isImporting,
  setIsImporting,
  onDone,
}: {
  readonly options: AgentSessionScanInput;
  readonly knownHistorySources: Set<AgentSessionSource>;
  readonly setOptions: (options: AgentSessionScanInput) => void;
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount?: number,
  ) => Promise<boolean>;
}) {
  const { environments } = useEnvironments();
  const writableEnvironments = useEnvironmentsWithScope(scans, AuthOrchestrationOperateScope);
  const [exportPaths, setExportPaths] = useState((options.exportPaths ?? []).join("\n"));
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const catalogAccountId = useAtomValue(minesAccountIdAtom) ?? "local-device";
  const { available: candidates } = partitionOnboardingProjects(
    scans.flatMap((scan) =>
      (scan.data?.candidates ?? []).map((candidate) => ({
        ...candidate,
        environmentId: scan.environmentId,
        key: onboardingProjectKey(scan.environmentId, candidate.path),
      })),
    ),
  );
  const detectedSources = new Set(
    candidates.flatMap((candidate) =>
      candidate.threadCount > 0 || (candidate.threads?.length ?? 0) > 0 ? candidate.sources : [],
    ),
  );
  useEffect(() => {
    for (const source of detectedSources) knownHistorySources.add(source);
  }, [detectedSources, knownHistorySources]);
  const currentSelection = selection ?? {
    projects: new Set(candidates.map((candidate) => candidate.key)),
    threads: new Map<string, ReadonlySet<string>>(),
  };
  const selected = candidates.filter((candidate) => currentSelection.projects.has(candidate.key));
  const selectedCounts = importSelectionCounts(candidates, currentSelection);
  const importIssues = scans.flatMap((scan) => {
    const label =
      environments.find((environment) => environment.environmentId === scan.environmentId)?.label ??
      "Computer";
    return [
      ...(scan.error
        ? [
            {
              key: `${scan.environmentId}:error`,
              label,
              message: `Could not check projects. ${scan.error}`,
              refresh: scan.refresh,
            },
          ]
        : []),
      ...(scan.data?.truncated
        ? [
            {
              key: `${scan.environmentId}:limit`,
              label,
              message: SCAN_LIMIT_MESSAGE,
              refresh: scan.refresh,
            },
          ]
        : []),
      ...importIssueReports(scan.data?.sourceReports ?? []).map((report) => ({
        key: `${scan.environmentId}:${report.source}:${report.message.trim()}`,
        label,
        message: `${importSourceLabel(report.source)}: ${report.message}`,
        refresh: null,
      })),
    ];
  });

  const canImport = selected.every((candidate) =>
    writableEnvironments.has(candidate.environmentId),
  );
  const [importError, setImportError] = useState("");
  const visibleImportError = !canImport
    ? IMPORT_PERMISSION_MESSAGE
    : importError === IMPORT_PERMISSION_MESSAGE
      ? ""
      : importError;

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    if (
      !selection.every((candidate) =>
        readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope),
      )
    ) {
      setImportError(IMPORT_PERMISSION_MESSAGE);
      return;
    }
    setIsImporting(true);
    setImportError("");
    try {
      backgroundImports.enqueue(
        selection.map((candidate) => {
          const existingProjectId = resolveOnboardingProjectId(
            readProjects(),
            candidate.environmentId,
            candidate,
          );
          const projectId = existingProjectId ?? newProjectId();
          return {
            id: randomUUID(),
            environmentId: candidate.environmentId,
            environmentLabel:
              environments.find(
                (environment) => environment.environmentId === candidate.environmentId,
              )?.label ?? "Computer",
            projectId,
            commandId: CommandId.make(`mines:import:project:${projectId}`),
            title: candidate.title,
            catalogAccountId,
            ...(candidate.sourceSection === undefined
              ? {}
              : { sourceSection: candidate.sourceSection }),
            ...(candidate.sourceProject === undefined
              ? {}
              : { sourceProject: candidate.sourceProject }),
            workspaceRoot: candidate.path,
            createWorkspaceRootIfMissing: candidate.workspaceAvailable === false,
            projectReady: existingProjectId !== null,
            options: {
              ...(currentSelection.threads.has(candidate.key)
                ? { threadKeys: [...currentSelection.threads.get(candidate.key)!] }
                : {}),
              ...(options.sources === undefined ? {} : { sources: options.sources }),
              ...(options.exportPaths === undefined ? {} : { exportPaths: options.exportPaths }),
              ...(candidate.sourceWorkspaceRoot === undefined
                ? {}
                : { sourceWorkspaceRoot: candidate.sourceWorkspaceRoot }),
            },
          };
        }),
      );
      await onDone(
        undefined,
        `${selectedCounts.conversations} conversations${selectedCounts.subagents ? ` and ${selectedCounts.subagents} subagents` : ""} queued in the background. Open Imports in Settings to see progress or pause. Keep mines running; after quitting, resume from the saved batch.`,
        0,
      );
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not save the import queue.");
    } finally {
      setIsImporting(false);
    }
  };

  if (scans.every((scan) => scan.data === null) && scans.some((scan) => scan.isPending)) {
    return (
      <div className="flex h-full min-h-40 flex-col">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Your conversations
        </h1>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6">
          <Spinner size="lg" tone="muted" />
          <p className="text-center text-sm text-muted-foreground">
            Looking for retained history on your computers…
          </p>
        </div>
        <div className="flex justify-end">
          <Button variant="ghost-muted" onClick={() => void onDone()}>
            Do not import conversations
          </Button>
        </div>
      </div>
    );
  }

  return (
    <StepShell title="Import conversations" description="Bring existing conversations into mines.">
      <fieldset disabled={isImporting} className="mb-4 space-y-3">
        <legend className="mb-2 text-sm font-medium">History sources</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {(
            [
              ["codex", "Codex"],
              ["claudeAgent", "Claude Code"],
              ["opencode", "OpenCode"],
              ["antigravity", "Antigravity"],
              ["t3code", "T3 Code"],
            ] as const
          )
            .filter(([source]) => detectedSources.has(source) || knownHistorySources.has(source))
            .map(([source, label]) => (
              <label key={source} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={options.sources?.includes(source) ?? true}
                  onChange={(event) =>
                    setOptions({
                      ...options,
                      sources: event.target.checked
                        ? [...(options.sources ?? []), source]
                        : options.sources?.filter((value) => value !== source),
                    })
                  }
                />
                {label}
              </label>
            ))}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Add exported history</summary>
          <label
            className="mt-2 block text-xs text-muted-foreground"
            htmlFor="history-export-paths"
          >
            Absolute export or previous T3 Code SQLite database paths on the selected computer, one
            per line
          </label>
          <textarea
            id="history-export-paths"
            className="mt-1 w-full rounded-lg border border-border bg-background p-2 text-sm"
            rows={2}
            value={exportPaths}
            onChange={(event) => setExportPaths(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setOptions({
                ...options,
                exportPaths: exportPaths
                  .split("\n")
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          >
            Scan exports
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            OpenCode JSON exports and Antigravity text or ACP replay exports are imported as
            transcripts. Native formats that cannot be read safely are reported below.
          </p>
        </details>
      </fieldset>
      {candidates.length > 0 ? (
        <div className="mt-5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span role="status">
            {selectedCounts.conversations}{" "}
            {selectedCounts.conversations === 1 ? "conversation" : "conversations"}
            {selectedCounts.subagents ? ` · ${selectedCounts.subagents} subagents` : ""} selected
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={
                isImporting ||
                (selected.length === candidates.length && currentSelection.threads.size === 0)
              }
              onClick={() =>
                setSelection({
                  projects: new Set(candidates.map((item) => item.key)),
                  threads: new Map(),
                })
              }
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={isImporting || selected.length === 0}
              onClick={() => setSelection({ projects: new Set(), threads: new Map() })}
            >
              Select none
            </Button>
          </div>
        </div>
      ) : null}
      <ScrollArea scrollFade className="mt-2 h-auto max-h-80">
        <div className="space-y-5 pr-3">
          {scans.map((scan) => {
            const scanCandidates = candidates.filter(
              (candidate) => candidate.environmentId === scan.environmentId,
            );
            const label =
              environments.find((environment) => environment.environmentId === scan.environmentId)
                ?.label ?? "Computer";
            return (
              <fieldset
                key={scan.environmentId}
                className="min-w-0 space-y-0.5"
                disabled={isImporting}
              >
                {scans.length > 1 ? (
                  <legend className="mb-2 text-sm font-medium">{label}</legend>
                ) : null}
                {scan.isPending && scan.data === null ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                    <Spinner size="md" />
                    Looking for projects…
                  </div>
                ) : scan.error === null && scanCandidates.length === 0 ? (
                  <p className="py-2 text-sm text-muted-foreground">
                    No retained projects found for these sources.
                  </p>
                ) : null}
                <ImportProjectPreview
                  candidates={scanCandidates}
                  selection={currentSelection}
                  onSelectionChange={(changes) =>
                    setSelection(updateImportSelection(currentSelection, candidates, changes))
                  }
                />
              </fieldset>
            );
          })}
        </div>
      </ScrollArea>
      {importIssues.length > 0 ? (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Import issues ({importIssues.length})</summary>
          <ul className="mt-2 space-y-2">
            {importIssues.map((issue) => (
              <li key={issue.key} className="flex items-start justify-between gap-3">
                <span className="[overflow-wrap:anywhere]">
                  {scans.length > 1 ? `${issue.label}: ` : ""}
                  {issue.message}
                </span>
                {issue.refresh ? (
                  <Button variant="ghost" size="xs" onClick={issue.refresh}>
                    Retry
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {visibleImportError ? (
        <p className="mt-3 text-sm text-destructive">{visibleImportError}</p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        <Button variant="ghost-muted" disabled={isImporting} onClick={() => void onDone()}>
          Do not import conversations
        </Button>
        <Button
          autoFocus
          disabled={!canImport || isImporting || selected.length === 0}
          onClick={() => void runImport(selected)}
        >
          {isImporting ? "Saving queue…" : "Import selected conversations"}
        </Button>
      </div>
    </StepShell>
  );
}

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}
