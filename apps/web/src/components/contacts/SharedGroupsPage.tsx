import { useAtomValue } from "@effect/atom-react";
import { minesAccountEnvironmentIdsAtom } from "@t3tools/client-runtime/catalog";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import type { SharedContactGroup } from "@t3tools/contracts/contacts";
import { Link, useSearch } from "@tanstack/react-router";
import { contactGroupMembershipInvitationId } from "@t3tools/shared/minesContacts";
import {
  ArrowLeftIcon,
  BellIcon,
  ContactRoundIcon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Atom } from "effect/reactivity";
import { hasMinesIdentityConfig } from "../../cloud/publicConfig";
import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { groupCreate } from "../../state/groups";
import { peerConnectionState, peerState, readPeerConnectionState } from "../../state/peers";
import { useEnvironmentQuery } from "../../state/query";
import { sharedGroupLeave } from "../../state/sharedGroups";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ContactAvatar, ContactInvitationInbox, ContactsPageFrame } from "./ContactsPage";
import { useContacts, useContactInvitationCount } from "./ContactsProvider";
import { checkSharedGroupHost } from "./sharedGroupHost";
import { SharedGroupConversation } from "./SharedGroupConversation";

const noLocalLeavePermission = Atom.make(false);

function SharedGroupHostAccountGate({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const { userId } = useMinesAuth();
  const connection = useEnvironmentQuery(peerConnectionState({ environmentId, input: {} }));
  if (connection.data?.configured && connection.data.accountId === userId) return children;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 p-4">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {connection.isPending
          ? "Checking your computer’s account…"
          : "Connect this computer to your mines account to share groups."}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={connection.isPending}
        onClick={connection.refresh}
      >
        <RefreshCwIcon />
        Check again
      </Button>
      <Button size="sm" variant="ghost-muted" render={<Link to="/settings/connections" />}>
        Connections
      </Button>
    </div>
  );
}

function SharedGroupLeaveAction({
  invitationId,
  group,
  environmentId,
}: {
  readonly invitationId: string;
  readonly group: SharedContactGroup;
  readonly environmentId: EnvironmentId | null;
}) {
  const { userId } = useMinesAuth();
  const { busy, pending, mutate } = useContacts();
  const connection = useEnvironmentQuery(
    environmentId ? peerConnectionState({ environmentId, input: {} }) : null,
  );
  const leave = useAtomCommand(sharedGroupLeave, { reportFailure: false });
  const readConnection = useAtomCommand(readPeerConnectionState, { reportFailure: false });
  const allowed = useAtomValue(
    environmentId ? sharedGroupLeave.permissionAtom(environmentId) : noLocalLeavePermission,
  );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || pending}
      onClick={() =>
        void mutate(async (client) => {
          if (
            environmentId &&
            allowed &&
            connection.data?.configured &&
            connection.data.accountId === userId
          ) {
            await checkSharedGroupHost(environmentId, userId, readConnection).then(
              () =>
                leave({
                  environmentId,
                  input: { groupKey: group.key, coordinatorDeviceId: group.coordinatorDeviceId },
                }),
              () => undefined,
            );
          }
          return client.respond(invitationId, "leave");
        })
      }
    >
      <LogOutIcon />
      Leave group
    </Button>
  );
}

function SharedGroupCreate({
  environmentId,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onCreated: (key: string) => void;
}) {
  const peer = useEnvironmentQuery(peerState({ environmentId, input: {} }));
  const { data, mutate, busy: accountBusy, pending } = useContacts();
  const allowed = useAtomValue(groupCreate.permissionAtom(environmentId));
  const create = useOrchestrationCommand(groupCreate, { reportFailure: false });
  const readConnection = useAtomCommand(readPeerConnectionState, { reportFailure: false });
  const { userId } = useMinesAuth();
  const [name, setName] = useState("");
  const [requestId, setRequestId] = useState(randomUUID);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!peer.data || !data || !allowed || busy || accountBusy || pending || !name.trim()) return;
    const coordinatorDeviceId = peer.data.device.deviceId;
    setBusy(true);
    setError(null);
    try {
      await checkSharedGroupHost(environmentId, userId, readConnection);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Your computer’s account could not be checked.",
      );
      setBusy(false);
      return;
    }
    let group = created;
    if (!group) {
      const result = await create({
        environmentId,
        input: {
          name: name.trim(),
          workflow: "team",
          visibility: "shared",
          members: [],
          clientRequestId: requestId,
        },
      });
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "The group could not be created.");
        setBusy(false);
        return;
      }
      group = { id: result.value.group.id, name: result.value.group.name };
      setCreated(group);
    }
    const savedGroup = group;
    const saved = await mutate(async (client) => {
      const snapshot = await client.registerGroup({
        clientRequestId: requestId,
        groupId: savedGroup.id,
        groupName: savedGroup.name,
        coordinatorEnvironmentId: environmentId,
        coordinatorDeviceId,
      });
      return snapshot;
    });
    setBusy(false);
    if (saved) {
      setName("");
      setCreated(null);
      setRequestId(randomUUID());
      const registered = saved.groups.find(
        (entry) =>
          entry.groupId === savedGroup.id && entry.coordinatorEnvironmentId === environmentId,
      );
      if (registered) onCreated(registered.key);
    }
  };
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border/70 p-4"
      aria-label="Create a shared group"
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="min-w-40 flex-1">
          <Input
            aria-label="Group name"
            placeholder="Name your group"
            maxLength={120}
            value={name}
            disabled={created !== null || busy}
            onValueChange={setName}
          />
        </div>
        <Button
          type="submit"
          disabled={!name.trim() || !allowed || !peer.data || busy || accountBusy || pending}
        >
          <PlusIcon />
          {busy ? "Creating…" : created ? "Retry saving group" : "Create group"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Invite friends, then choose which of your chats to bring. Your other mines stay private.
      </p>
      {peer.error || error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? peer.error}
        </p>
      ) : null}
      {!allowed ? (
        <p className="text-xs text-muted-foreground">This connection cannot create groups.</p>
      ) : null}
    </section>
  );
}

function SharedGroupPeople({ group }: { readonly group: SharedContactGroup }) {
  const { data, busy, pending, mutate } = useContacts();
  const [friendId, setFriendId] = useState<string | null>(null);
  if (!data) return null;
  const owned = group.owner.friendId === data.profile.friendId;
  const invitations = data.invitations.filter((entry) => entry.groupKey === group.key);
  const pendingIds = new Set(
    invitations
      .filter((entry) => entry.status === "pending")
      .map((entry) => entry.invitee.friendId),
  );
  const memberIds = new Set(group.members.map((member) => member.friendId));
  const available = data.contacts.filter(
    (friend) => !memberIds.has(friend.friendId) && !pendingIds.has(friend.friendId),
  );
  const selected = available.find((friend) => friend.friendId === friendId);
  return (
    <section
      aria-label="People in this group"
      className="flex flex-col gap-3 rounded-xl border border-border/70 p-4"
    >
      <h2 className="text-sm font-medium">People</h2>
      <div className="flex flex-wrap gap-3">
        {group.members.map((member) => {
          const invitationId = contactGroupMembershipInvitationId(
            group,
            member.friendId,
            invitations,
          );
          return (
            <div key={member.friendId} className="flex items-center gap-2">
              <ContactAvatar profile={member} />
              <span className="text-sm">
                {member.displayName}
                {member.friendId === group.owner.friendId ? (
                  <span className="ml-1 text-xs text-muted-foreground">Owner</span>
                ) : null}
              </span>
              {owned && invitationId ? (
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Remove ${member.displayName} from group`}
                  disabled={busy || pending}
                  onClick={() => void mutate((client) => client.respond(invitationId, "revoke"))}
                >
                  <XIcon />
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      {owned ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected)
              void mutate((client) =>
                client.invite({
                  clientRequestId: randomUUID(),
                  friendId: selected.friendId,
                  groupId: group.groupId,
                  groupName: group.groupName,
                  coordinatorEnvironmentId: group.coordinatorEnvironmentId,
                  coordinatorDeviceId: group.coordinatorDeviceId,
                }),
              ).then((saved) => {
                if (saved) setFriendId(null);
              });
          }}
        >
          <div className="min-w-40 flex-1">
            <Select value={selected?.friendId ?? null} onValueChange={setFriendId}>
              <SelectTrigger aria-label="Friend to invite">
                <SelectValue
                  placeholder={available.length ? "Choose a friend" : "No other contacts to invite"}
                />
              </SelectTrigger>
              <SelectPopup>
                {available.map((friend) => (
                  <SelectItem key={friend.friendId} value={friend.friendId}>
                    {friend.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={!selected || busy || pending}>
            <UserPlusIcon />
            Invite
          </Button>
        </form>
      ) : null}
      {owned
        ? invitations
            .filter((entry) => entry.status === "pending")
            .map((invitation) => (
              <div
                key={invitation.id}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="flex-1">Waiting for {invitation.invitee.displayName}</span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busy || pending}
                  onClick={() => void mutate((client) => client.respond(invitation.id, "revoke"))}
                >
                  <XIcon />
                  Revoke invitation
                </Button>
              </div>
            ))
        : null}
    </section>
  );
}

function ManagedSharedGroupsPage() {
  const { data, pending, busy, error, signedIn, refresh } = useContacts();
  const { userId, openAccount } = useMinesAuth();
  const invitations = useContactInvitationCount();
  const primary = usePrimaryEnvironmentId();
  const owned = useAtomValue(minesAccountEnvironmentIdsAtom);
  const { environments } = useEnvironments();
  const hosts = environments.filter(
    (host) => host.connection.phase === "connected" && owned.has(host.environmentId),
  );
  const [hostId, setHostId] = useState<EnvironmentId | null>(null);
  const localHost =
    hosts.find((host) => host.environmentId === hostId) ??
    hosts.find((host) => host.environmentId === primary) ??
    hosts[0];
  const search = useSearch({ from: "/shared-groups" });
  const [selection, setSelection] = useState<{ requested: string | undefined; key: string | null }>(
    () => ({ requested: search.group, key: search.group ?? null }),
  );
  const selectedKey = selection.requested === search.group ? selection.key : (search.group ?? null);
  const setSelectedKey = (key: string | null) => setSelection({ requested: search.group, key });
  const selected = data?.groups.find((group) => group.key === selectedKey);
  const ownInvitationId =
    selected && data
      ? contactGroupMembershipInvitationId(selected, data.profile.friendId, data.invitations)
      : null;
  return (
    <ContactsPageFrame
      title="Workgroups"
      actions={
        <>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" size="sm" />}>
              <BellIcon />
              Invitations{invitations ? ` · ${invitations}` : ""}
            </PopoverTrigger>
            <PopoverPopup>
              <div className="max-w-md">
                <ContactInvitationInbox />
              </div>
            </PopoverPopup>
          </Popover>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Refresh workgroups"
            disabled={pending || busy || !signedIn}
            onClick={refresh}
          >
            <RefreshCwIcon />
          </Button>
          <Button variant="outline" size="sm" render={<Link to="/contacts" />}>
            <ContactRoundIcon />
            Contacts
          </Button>
        </>
      }
    >
      {!signedIn ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            Sign in to create groups with your friends.
          </p>
          <Button onClick={openAccount}>Sign in to mines</Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {pending && !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading workgroups…
        </p>
      ) : null}
      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-medium">{selected ? selected.groupName : "Your workgroups"}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Messages stay in the group. AI only replies when you ask.
              </p>
            </div>
            {selected ? (
              <Button size="sm" variant="ghost-muted" onClick={() => setSelectedKey(null)}>
                <ArrowLeftIcon />
                All groups
              </Button>
            ) : null}
            {selected && ownInvitationId ? (
              <SharedGroupLeaveAction
                invitationId={ownInvitationId}
                group={selected}
                environmentId={localHost?.environmentId ?? null}
              />
            ) : null}
          </div>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Your computer
            <div className="max-w-xs">
              <Select
                value={localHost?.environmentId ?? null}
                onValueChange={(value) => setHostId(value ? EnvironmentId.make(value) : null)}
              >
                <SelectTrigger aria-label="Your computer for workgroups">
                  <SelectValue placeholder="Connect your computer" />
                </SelectTrigger>
                <SelectPopup>
                  {hosts.map((host) => (
                    <SelectItem key={host.environmentId} value={host.environmentId}>
                      {host.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </label>
          {selected ? (
            <>
              <SharedGroupPeople key={`${userId}:${selected.key}`} group={selected} />
              {localHost ? (
                <SharedGroupHostAccountGate
                  key={`${userId}:${localHost.environmentId}:${selected.key}`}
                  environmentId={localHost.environmentId}
                >
                  <SharedGroupConversation
                    group={selected}
                    environmentId={localHost.environmentId}
                  />
                </SharedGroupHostAccountGate>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Connect your computer to open this group and bring your own chats.
                </p>
              )}
            </>
          ) : (
            <>
              {localHost ? (
                <SharedGroupHostAccountGate
                  key={`${userId}:${localHost.environmentId}`}
                  environmentId={localHost.environmentId}
                >
                  <SharedGroupCreate
                    environmentId={localHost.environmentId}
                    onCreated={setSelectedKey}
                  />
                </SharedGroupHostAccountGate>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Connect your computer to create a group or open a shared conversation.
                </p>
              )}
              <section aria-label="Workgroups" className="grid gap-3 sm:grid-cols-2">
                {data.groups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/70 p-4 text-left outline-hidden hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => setSelectedKey(group.key)}
                  >
                    <UsersIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{group.groupName}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {group.members.length} {group.members.length === 1 ? "person" : "people"} ·{" "}
                        {group.owner.displayName}
                      </span>
                    </span>
                  </button>
                ))}
              </section>
              {data.groups.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  Create a group or accept an invitation to get started.
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </ContactsPageFrame>
  );
}

export function SharedGroupsPage() {
  return hasMinesIdentityConfig() ? (
    <ManagedSharedGroupsPage />
  ) : (
    <ContactsPageFrame title="Workgroups">
      <p className="text-sm text-muted-foreground">
        Configure the mines account service to share groups with friends.
      </p>
    </ContactsPageFrame>
  );
}
