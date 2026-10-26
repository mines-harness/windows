import { useState } from "react";
import { MonitorIcon, CheckIcon, CloudIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";
import { cloudSnapshot } from "../../state/cloudTasks";
import { useEnvironmentQuery } from "../../state/query";
import { composerDeviceLabel } from "./composerDeviceLabel";

export function ComposerDevicePicker({
  environmentId,
  size = "sm",
  disabled = false,
  onConfigureWorkflow,
}: {
  environmentId: EnvironmentId;
  size?: "sm" | "xs";
  disabled?: boolean;
  onConfigureWorkflow?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { environments } = useEnvironments();
  const projects = useProjects();
  const newThread = useNewThreadHandler();
  const { startScratchThread } = useScratchProject();
  const current = environments.find((device) => device.environmentId === environmentId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            disabled={disabled}
            aria-label="Execution device"
            data-composer-fixed-control
            className="min-w-20 max-w-36 shrink-0 @max-[400px]/composer-surface:max-w-24"
          />
        }
      >
        <MonitorIcon aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 truncate" data-composer-control-label />}
          >
            {composerDeviceLabel(current)}
          </TooltipTrigger>
          <TooltipPopup side="top">{composerDeviceLabel(current)}</TooltipPopup>
        </Tooltip>
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start">
        <div className="w-72 space-y-1 p-2">
          <p className="px-2 py-1 text-xs text-muted-foreground">Choose where the next mine runs</p>
          {environments.map((device) => (
            <button
              key={device.environmentId}
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
              disabled={
                device.connection.phase !== "connected" && device.environmentId !== environmentId
              }
              onClick={async () => {
                setOpen(false);
                if (device.environmentId === environmentId) return;
                const project = projects.find(
                  (entry) => entry.environmentId === device.environmentId,
                );
                if (project) await newThread(scopeProjectRef(device.environmentId, project.id));
                else await startScratchThread(device.environmentId);
              }}
            >
              <MonitorIcon className="size-4" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{composerDeviceLabel(device)}</span>
                <span className="block text-xs text-muted-foreground">
                  {device.environmentId === environmentId
                    ? "Current mine"
                    : device.connection.phase === "connected"
                      ? "Start a new mine here"
                      : "Offline · saved in your library"}
                </span>
              </span>
              {device.environmentId === environmentId ? <CheckIcon className="size-4" /> : null}
            </button>
          ))}
          <p className="px-2 pt-3 pb-1 text-xs text-muted-foreground">Cloud devices</p>
          {environments.map((device) => (
            <CloudDeviceChoices
              key={device.environmentId}
              environmentId={device.environmentId}
              hostLabel={composerDeviceLabel(device)}
              hostConnected={device.connection.phase === "connected"}
              onSelect={() => setOpen(false)}
            />
          ))}
          <p className="px-2 pt-2 text-xs leading-relaxed text-muted-foreground">
            Existing mines stay on their original device. Models are provided by the selected
            device.
          </p>
          {onConfigureWorkflow ? (
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-accent"
              onClick={() => {
                setOpen(false);
                onConfigureWorkflow();
              }}
            >
              Use multiple devices in a workflow…
            </button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function CloudDeviceChoices({
  environmentId,
  hostLabel,
  hostConnected,
  onSelect,
}: {
  environmentId: EnvironmentId;
  hostLabel: string;
  hostConnected: boolean;
  onSelect: () => void;
}) {
  const router = useRouter();
  const snapshot = useEnvironmentQuery(cloudSnapshot({ environmentId, input: {} }));
  return (
    <>
      {!hostConnected ? (
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
          {hostLabel} is offline. Reconnect to check its cloud accounts.
        </p>
      ) : snapshot.error ? (
        <div className="space-y-1 px-3 py-2 text-xs">
          <p role="alert">Could not check cloud accounts on {hostLabel}.</p>
          <p className="text-muted-foreground">{snapshot.error}</p>
          <button
            type="button"
            className="rounded text-left underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
            disabled={snapshot.isPending}
            onClick={snapshot.refresh}
          >
            Retry cloud connection
          </button>
        </div>
      ) : snapshot.isPending || !snapshot.data ? (
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
          Checking cloud accounts on {hostLabel}…
        </p>
      ) : snapshot.data.targets.length === 0 ? (
        <div className="space-y-1 px-3 py-2 text-xs">
          <p>No Codex or Claude cloud accounts on {hostLabel}.</p>
          <button
            type="button"
            className="rounded text-left underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => {
              onSelect();
              void router.navigate({
                to: "/settings/providers",
                search: { environmentId },
              });
            }}
          >
            Set up a provider account
          </button>
        </div>
      ) : null}
      {snapshot.data?.targets.map((target) => (
        <button
          key={target.id}
          type="button"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => {
            onSelect();
            void router.navigate({
              to: "/$environmentId/cloud/$targetId",
              params: { environmentId, targetId: target.id },
            });
          }}
        >
          <CloudIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{target.label}</span>
            <span className="block text-xs text-muted-foreground">
              {hostConnected
                ? target.bridgeStatus === "available" && target.capabilities.submit
                  ? `Open cloud workspace · via ${hostLabel}`
                  : (target.reason ?? "Setup needed · open cloud details")
                : "Cloud runs independently · computer offline"}
            </span>
          </span>
        </button>
      ))}
    </>
  );
}
