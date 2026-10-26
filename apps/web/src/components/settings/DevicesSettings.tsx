import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type { DevicePairingRequest } from "@t3tools/contracts/minesDevicePairing";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, PlusIcon, RefreshCwIcon } from "lucide-react";

import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { hasMinesIdentityConfig, minesControlUrl } from "../../cloud/publicConfig";
import { environmentCatalog } from "../../connection/catalog";
import {
  beginPeerPairing,
  cancelPeerPairing,
  collectPeerPairing,
  forgetPeerClient,
  peerClientApproval,
} from "../../connection/peerOnboarding";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { environmentPeerDevicesAtom } from "../../state/environmentPeerDevices";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useMinesAuthPrompt } from "../clerk/useMinesAuthPrompt";
import { isElectron } from "../../env";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ConnectionsAdvancedSettings } from "./ConnectionsAdvancedSettings";
import { AddSshComputer } from "./AddSshComputer";
import { DeviceCliUpdateAction } from "./DeviceCliUpdateAction";
import { PeerDeviceIcon } from "../PeerDeviceIcon";
import { buildDeviceList, type DeviceListRow } from "./deviceList.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { ThisComputerAccess } from "./ThisComputerAccess";
import { useAccountPeerDirectory } from "./useAccountPeerDirectory";

type PendingPairing = Pick<DevicePairingRequest, "id" | "code" | "expiresAt" | "target">;

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "The computer could not be connected. Try again.";
}

function AdvancedConnections() {
  const target = useSettingsSearchTargetId();
  const isAdvancedTarget = (id: string | null) =>
    id !== null && id !== "this-computer-access" && id !== "your-other-computers";
  const [open, setOpen] = useState(() => isAdvancedTarget(target));
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== lastTarget) {
    setLastTarget(target);
    if (isAdvancedTarget(target)) setOpen(true);
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button size="sm" variant="ghost-muted" />}>
        Advanced <ChevronDownIcon />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-5">{open ? <ConnectionsAdvancedSettings /> : null}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function DevicesSettings() {
  return hasMinesIdentityConfig() ? <AccountDevicesPage /> : <LocalDevicesPage />;
}

function LocalDevicesPage() {
  const { environments } = useEnvironments();
  const [adding, setAdding] = useState(false);
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Your devices"
        headerAction={
          isElectron ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <PlusIcon /> Add device
            </Button>
          ) : undefined
        }
      >
        {environments.map((environment) => (
          <SettingsRow
            key={environment.environmentId}
            title={environment.label}
            description={
              environment.connection.phase === "connected" ? "Connected" : "Not connected"
            }
          />
        ))}
      </SettingsSection>
      <AdvancedConnections />
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add a computer</DialogTitle>
            <DialogDescription>Connect to a computer you can access over SSH.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <AddSshComputer onConnected={() => setAdding(false)} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}

function AccountDevicesPage() {
  const { userId } = useMinesAuth();
  return <AccountDevicesContent key={userId ?? "signed-out"} />;
}

function AccountDevicesContent() {
  const auth = useMinesAuth();
  const { openAuthPrompt } = useMinesAuthPrompt();
  const primary = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  const directory = useAccountPeerDirectory();
  const environmentDevices = useAtomValue(environmentPeerDevicesAtom);
  const approval = useAtomCommand(peerClientApproval, { reportFailure: false });
  const begin = useAtomCommand(beginPeerPairing, { reportFailure: false });
  const collect = useAtomCommand(collectPeerPairing, { reportFailure: false });
  const cancel = useAtomCommand(cancelPeerPairing, { reportFailure: false });
  const retry = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const forget = useAtomCommand(forgetPeerClient, { reportFailure: false });
  const navigate = useNavigate();
  const [clientDeviceId, setClientDeviceId] = useState<string | null>(null);
  const [hostDeviceIds, setHostDeviceIds] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<PendingPairing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const mounted = useRef(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const loadIdentity = useEffectEvent((accountId: string, active: () => boolean) => {
    void approval(accountId).then((result) => {
      if (active() && result._tag === "Success") setClientDeviceId(result.value.device.deviceId);
    });
  });
  useEffect(() => {
    let active = true;
    if (auth.isSignedIn && auth.userId) loadIdentity(auth.userId, () => active);
    return () => {
      active = false;
    };
  }, [auth.isSignedIn, auth.userId]);

  const disposePairing = useEffectEvent(() => {
    if (pending && auth.userId) void cancel({ accountId: auth.userId, requestId: pending.id });
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      disposePairing();
    };
  }, []);

  const poll = useEffectEvent((requestId: string) =>
    collect({
      accountId: auth.userId!,
      requestId,
      getToken: auth.getToken,
    }),
  );
  const paired = useEffectEvent(() => directory.refresh());
  useEffect(() => {
    if (!pending || !auth.userId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const result = await poll(pending.id);
      if (!active) return;
      if (result._tag !== "Success") {
        setError(message(squashAtomCommandFailure(result)));
        setPending(null);
      } else if (result.value.status === "pending") {
        timer = setTimeout(() => {
          void check();
        }, 2_000);
      } else {
        if (result.value.status !== "connected") {
          setError(
            result.value.status === "denied"
              ? "The other computer declined this request."
              : "This request expired or was cancelled. Connect again when you’re ready.",
          );
        }
        setPending(null);
        paired();
      }
    };
    void check();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [pending, auth.userId]);

  const rows = buildDeviceList({
    environments,
    environmentDevices,
    directory: directory.data,
    localDeviceIds: [...hostDeviceIds, ...(clientDeviceId ? [clientDeviceId] : [])],
  });
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );

  const connect = async (row: DeviceListRow) => {
    const controlUrl = minesControlUrl();
    if (!auth.userId || !row.accountDeviceId || !controlUrl || busy || pending) return;
    const accountId = auth.userId;
    setBusy(row.id);
    setError(null);
    const result = await begin({
      accountId,
      targetDeviceId: row.accountDeviceId,
      controlUrl,
      getToken: auth.getToken,
      ...(primary ? { label: primary.label } : {}),
    });
    if (!mounted.current) {
      if (result._tag === "Success") void cancel({ accountId, requestId: result.value.id });
      return;
    }
    if (result._tag === "Success") setPending(result.value);
    else setError(message(squashAtomCommandFailure(result)));
    setBusy(null);
  };
  const cancelRequest = async () => {
    if (!pending || !auth.userId) return;
    const request = pending;
    setPending(null);
    await cancel({ accountId: auth.userId, requestId: request.id });
  };
  const reconnect = async (row: DeviceListRow) => {
    if (!row.environmentId || busy) return;
    setBusy(row.id);
    setError(null);
    const result = await retry(row.environmentId);
    if (result._tag !== "Success") setError(message(squashAtomCommandFailure(result)));
    setBusy(null);
  };
  const remove = async (row: DeviceListRow) => {
    if (!auth.userId || !row.environmentId || busy) return;
    setBusy(row.id);
    setError(null);
    const result = await forget({ accountId: auth.userId, environmentId: row.environmentId });
    if (result._tag !== "Success") setError(message(squashAtomCommandFailure(result)));
    directory.refresh();
    setBusy(null);
  };

  return (
    <SettingsPageContainer>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 sm:px-4">
        <div>
          <h1 className="text-xl font-semibold">Devices</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect once. Work from any of your computers.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <PlusIcon /> Add device
        </Button>
      </div>
      {!auth.isSignedIn ? (
        <SettingsSection title="Your Mines account">
          <SettingsRow
            title="Sign in to see your other devices"
            description="Use the same account on every computer you want to connect."
            control={
              <Button size="sm" onClick={openAuthPrompt}>
                Sign in
              </Button>
            }
          />
        </SettingsSection>
      ) : null}
      {primary ? (
        <ThisComputerAccess
          key={`${auth.userId ?? "signed-out"}:${primary.environmentId}`}
          environmentId={primary.environmentId}
          name={primary.label}
          onIdentity={(id) =>
            setHostDeviceIds((current) => (current.includes(id) ? current : [...current, id]))
          }
        />
      ) : null}
      <SettingsSection
        id="your-other-computers"
        title="Your other devices"
        headerAction={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh devices"
            disabled={directory.isPending}
            onClick={directory.refresh}
          >
            <RefreshCwIcon />
          </Button>
        }
      >
        {rows.length ? (
          rows.map((row) => {
            const environment = row.environmentId
              ? environmentById.get(row.environmentId)
              : undefined;
            return (
              <SettingsRow
                key={row.id}
                title={
                  <span className="flex items-center gap-2">
                    <PeerDeviceIcon
                      platform={row.platform}
                      className="size-4 text-muted-foreground"
                    />
                    {row.name}
                  </span>
                }
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={row.status === "connected" ? "success" : "secondary"}>
                      {row.status === "connected"
                        ? "Connected"
                        : row.status === "needs-approval"
                          ? "Not paired"
                          : row.status === "connecting"
                            ? "Connecting…"
                            : "Not connected"}
                    </Badge>
                    {row.presence ? (
                      <span className="text-xs">
                        {row.presence === "online"
                          ? "Online"
                          : row.presence === "offline"
                            ? "Offline"
                            : "Availability unknown"}
                      </span>
                    ) : null}
                  </span>
                }
                control={
                  <div className="flex flex-wrap gap-2">
                    {environment ? <DeviceCliUpdateAction environment={environment} /> : null}
                    {row.status === "connected" && row.environmentId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void navigate({
                            to: "/settings/projects",
                            search: { machine: row.environmentId },
                          })
                        }
                      >
                        Projects
                      </Button>
                    ) : row.environmentId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void reconnect(row)}
                      >
                        {busy === row.id ? "Connecting…" : "Reconnect"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={
                          !auth.isSignedIn ||
                          busy !== null ||
                          pending !== null ||
                          row.presence === "offline"
                        }
                        onClick={() => void connect(row)}
                      >
                        {busy === row.id ? "Requesting…" : "Connect"}
                      </Button>
                    )}
                    {row.environmentId ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void remove(row)}
                      >
                        Forget
                      </Button>
                    ) : null}
                  </div>
                }
              />
            );
          })
        ) : (
          <SettingsRow
            title={directory.isPending ? "Looking for your computers…" : "No other computers yet"}
            description="Sign in to Mines on your other computer, then refresh this list."
          />
        )}
        {directory.error ? (
          <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
            Couldn’t refresh your devices. Try again in a moment.
          </p>
        ) : null}
      </SettingsSection>
      {pending ? (
        <SettingsSection title={`Connect to ${pending.target.label}`}>
          <div className="space-y-3 p-4">
            <p className="text-sm">
              Approve this request on the other computer. If it runs in a terminal, run:
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="break-all rounded-md bg-muted px-3 py-2 text-sm">
                mines devices approve {pending.code}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copyToClipboard(`mines devices approve ${pending.code}`)}
              >
                {isCopied ? "Copied" : "Copy command"}
              </Button>
            </div>
            <p role="status" className="text-sm text-muted-foreground">
              Waiting for approval… This request expires shortly.
            </p>
            <Button size="sm" variant="ghost" onClick={() => void cancelRequest()}>
              Cancel request
            </Button>
          </div>
        </SettingsSection>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <AdvancedConnections />
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add a device</DialogTitle>
            <DialogDescription>
              Sign in to the same Mines account on the other computer. It will appear in your device
              list.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <p className="text-sm">On a Mac or PC, open Mines and sign in.</p>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">On a server or over SSH:</p>
                <code className="block rounded-md bg-muted px-3 py-2 text-sm">
                  mines account login
                </code>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setAddOpen(false);
                  if (auth.isSignedIn) directory.refresh();
                  else openAuthPrompt();
                }}
              >
                {auth.isSignedIn ? "Find my devices" : "Sign in to Mines"}
              </Button>
              {isElectron ? (
                <AddSshComputer
                  onConnected={() => {
                    setAddOpen(false);
                    directory.refresh();
                  }}
                />
              ) : null}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
