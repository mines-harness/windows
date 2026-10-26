import { useEffect, useState, type FormEvent } from "react";
import type { DesktopDiscoveredSshHost, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { connectSshEnvironment } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function AddSshComputer({ onConnected }: { readonly onConnected: () => void }) {
  const connect = useAtomCommand(connectSshEnvironment, { reportFailure: false });
  const [destination, setDestination] = useState("");
  const [hosts, setHosts] = useState<readonly DesktopDiscoveredSshHost[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.desktopBridge?.discoverSshHosts().then(
      (result) => {
        if (active) setHosts(result);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  const value = destination.trim();
  const matching = hosts.find((host) => host.alias === value);
  const separator = value.lastIndexOf("@");
  const target: DesktopSshEnvironmentTarget = matching ?? {
    alias: value,
    hostname: separator >= 0 ? value.slice(separator + 1) : value,
    username: separator >= 0 ? value.slice(0, separator) : null,
    port: null,
  };
  const hasControlCharacter = Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  const valid =
    value.length > 0 &&
    !value.startsWith("-") &&
    !/\s/.test(value) &&
    !hasControlCharacter &&
    target.hostname.length > 0 &&
    separator !== 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const result = await connect({ target });
    if (result._tag === "Success") onConnected();
    else {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "The SSH connection failed. Check the host and try again.",
      );
    }
    setBusy(false);
  };
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-3 border-t border-border pt-4"
    >
      <div>
        <h3 className="text-sm font-medium">Connect over SSH</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Mines installs the CLI if needed. Your projects and provider accounts stay on the remote
          computer.
        </p>
      </div>
      <label className="block space-y-1.5 text-sm">
        <span>SSH host</span>
        <Input
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          placeholder="ovh or user@example.com"
          autoComplete="off"
          disabled={busy}
        />
      </label>
      {!value && hosts.length ? (
        <div className="flex flex-wrap gap-2">
          {hosts.slice(0, 6).map((host) => (
            <Button
              key={host.alias}
              size="sm"
              variant="outline"
              type="button"
              onClick={() => setDestination(host.alias)}
            >
              {host.alias}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button size="sm" type="submit" disabled={!valid || busy}>
        {busy ? "Preparing remote Mines…" : "Connect over SSH"}
      </Button>
    </form>
  );
}
