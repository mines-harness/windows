import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { minesDeviceSyncPreferences } from "../../cloud/minesDeviceSyncPreference";
import { minesControlUrl } from "../../cloud/publicConfig";
import {
  peerApprovePairing,
  peerConfigure,
  peerConnectionState,
  peerDenyPairing,
  peerDisable,
  peerPairingRequests,
  peerRevoke,
  peerState,
} from "../../state/peers";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMinesAuthPrompt } from "../clerk/useMinesAuthPrompt";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ThisComputerAccess({
  environmentId,
  name,
  onIdentity,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly onIdentity?: (deviceId: string) => void;
}) {
  const allowed = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  if (!allowed) {
    return (
      <SettingsSection id="this-computer-access" title="Access to this computer">
        <SettingsRow
          title={name}
          description="Open this computer's workspace to manage device access."
        />
      </SettingsSection>
    );
  }
  return (
    <ThisComputerAccessContent
      environmentId={environmentId}
      name={name}
      {...(onIdentity ? { onIdentity } : {})}
    />
  );
}

function ThisComputerAccessContent({
  environmentId,
  name,
  onIdentity,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly onIdentity?: (deviceId: string) => void;
}) {
  const { isSignedIn, userId, getToken } = useMinesAuth();
  const { openAuthPrompt } = useMinesAuthPrompt();
  const trust = useEnvironmentQuery(peerState({ environmentId, input: {} }));
  const connection = useEnvironmentQuery(peerConnectionState({ environmentId, input: {} }));
  const configured = connection.data?.configured === true;
  const updating =
    useAtomValue(serverEnvironment.updateStateAtom(environmentId)).status === "running";
  const currentAccount = useRef(userId);
  useEffect(() => {
    currentAccount.current = userId;
  }, [userId]);
  const requests = useEnvironmentQuery(
    configured && isSignedIn ? peerPairingRequests({ environmentId, input: {} }) : null,
  );
  const configure = useAtomCommand(peerConfigure, { reportFailure: false });
  const disable = useAtomCommand(peerDisable, { reportFailure: false });
  const revoke = useAtomCommand(peerRevoke, { reportFailure: false });
  const approve = useAtomCommand(peerApprovePairing, { reportFailure: false });
  const deny = useAtomCommand(peerDenyPairing, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reportIdentity = useEffectEvent((deviceId: string) => onIdentity?.(deviceId));
  const deviceId = trust.data?.device.deviceId;
  useEffect(() => {
    if (deviceId) reportIdentity(deviceId);
  }, [deviceId]);

  const refresh = () => {
    trust.refresh();
    connection.refresh();
    requests.refresh();
  };
  const refreshVisible = useEffectEvent(() => {
    if (document.visibilityState !== "visible") return;
    requests.refresh();
    trust.refresh();
    connection.refresh();
  });
  useEffect(() => {
    if (!configured || !isSignedIn) return;
    const interval = setInterval(refreshVisible, 10_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [configured, isSignedIn]);

  const updateAccess = async (enabled: boolean) => {
    if (busy) return;
    setBusy("access");
    setError(null);
    try {
      if (enabled) {
        const controlUrl = minesControlUrl();
        const accountId = userId;
        if (!accountId || !controlUrl) throw new Error("Sign in to Mines first.");
        const token = await getToken();
        if (!token || currentAccount.current !== accountId)
          throw new Error("Sign in to Mines first.");
        const stunUrl =
          import.meta.env.VITE_MINES_STUN_URL?.trim() ||
          `stun:${new URL(controlUrl).hostname}:3478`;
        const result = await configure({
          environmentId,
          input: { controlUrl, bearerToken: token, stunServers: [stunUrl] },
        });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        if (currentAccount.current === accountId)
          minesDeviceSyncPreferences.setEnabled({ accountId, environmentId, controlUrl }, true);
      } else {
        const previous = connection.data;
        let preferenceSaved = true;
        if (previous?.accountId && previous.controlUrl) {
          try {
            minesDeviceSyncPreferences.setEnabled(
              { accountId: previous.accountId, environmentId, controlUrl: previous.controlUrl },
              false,
            );
          } catch {
            preferenceSaved = false;
          }
        }
        const result = await disable({ environmentId, input: {} });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        if (!preferenceSaved)
          setError(
            "Access is off, but this preference could not be saved. Try again before restarting Mines.",
          );
      }
      refresh();
    } catch {
      setError("Device access could not be updated. Try again.");
      refresh();
    } finally {
      setBusy(null);
    }
  };
  const answerRequest = async (code: string, accept: boolean) => {
    if (busy) return;
    setBusy(code);
    setError(null);
    try {
      const scopes = AuthStandardClientScopes.filter((scope) =>
        readEnvironmentScope(environmentId, scope),
      );
      if (accept && scopes.length === 0) throw new Error("Device access is unavailable.");
      const result = accept
        ? await approve({ environmentId, input: { code, scopes } })
        : await deny({ environmentId, input: { code } });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      refresh();
    } catch {
      setError("This request could not be updated. Refresh and try again.");
      requests.refresh();
    } finally {
      setBusy(null);
    }
  };
  const revokeAccess = async (deviceId: string) => {
    if (busy) return;
    setBusy(deviceId);
    setError(null);
    try {
      const result = await revoke({ environmentId, input: { deviceId } });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      refresh();
    } catch {
      setError("Access could not be revoked. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const accountMatches = connection.data?.accountId === userId;
  const approved = trust.data?.approvedDevices ?? [];
  const pending = accountMatches ? (requests.data ?? []) : [];
  const description =
    connection.error && !connection.data
      ? "Device access is unavailable. Refresh to try again."
      : connection.isPending && !connection.data
        ? "Checking device access…"
        : configured
          ? connection.data?.online
            ? "Ready for connections. Keep this computer awake to use it remotely."
            : updating
              ? "Updating this computer…"
              : "Connection interrupted. Reconnect to make this computer available again."
          : "Off. Your work on this computer continues normally.";

  return (
    <SettingsSection
      id="this-computer-access"
      title="Access to this computer"
      headerAction={
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={refresh}>
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{name}</span>
            <Badge variant="secondary">This computer</Badge>
          </span>
        }
        description={description}
        control={
          <div className="flex items-center gap-3">
            <span className="text-sm">Allow connections</span>
            <Switch
              checked={configured}
              disabled={busy !== null || connection.data === null || (!isSignedIn && !configured)}
              onCheckedChange={(enabled) => void updateAccess(enabled)}
              aria-label="Allow connections to this computer"
            />
          </div>
        }
      />
      {!isSignedIn ? (
        <SettingsRow
          title="Connect your devices"
          description="Sign in to the same Mines account on each device."
          control={
            <Button size="sm" onClick={openAuthPrompt}>
              Sign in to Mines
            </Button>
          }
        />
      ) : configured && !connection.data?.online && !updating ? (
        <SettingsRow
          title="Make this computer available"
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void updateAccess(true)}
            >
              {busy === "access" ? "Reconnecting…" : "Reconnect"}
            </Button>
          }
        />
      ) : null}
      {pending.map((request) => (
        <SettingsRow
          key={request.id}
          title={`${request.requester.label} wants to connect`}
          description={`Allow only if code ${request.code.slice(0, 4)} ${request.code.slice(4)} matches the other device.`}
          control={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void answerRequest(request.code, false)}
              >
                Decline
              </Button>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void answerRequest(request.code, true)}
              >
                {busy === request.code ? "Updating…" : "Allow access"}
              </Button>
            </div>
          }
        />
      ))}
      {approved.map((device) => (
        <SettingsRow
          key={device.deviceId}
          title={device.label}
          description={configured ? "Can access this computer" : "Access paused"}
          control={
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void revokeAccess(device.deviceId)}
            >
              {busy === device.deviceId ? "Revoking…" : "Revoke access"}
            </Button>
          }
        />
      ))}
      {configured &&
      approved.length === 0 &&
      pending.length === 0 &&
      requests.data !== null &&
      trust.data !== null &&
      !requests.error &&
      !trust.error ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          No other devices have access yet. Connection requests will appear here.
        </p>
      ) : null}
      {error || connection.error || trust.error || (configured && requests.error) ? (
        <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
          {error ?? "Device access could not be loaded. Refresh to try again."}
        </p>
      ) : null}
    </SettingsSection>
  );
}
