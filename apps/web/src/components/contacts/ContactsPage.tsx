import { CONTACT_AVATAR_MAX_BYTES, type ContactProfile } from "@t3tools/contracts/contacts";
import { incomingContactInvitations } from "@t3tools/shared/minesContacts";
import { Link } from "@tanstack/react-router";
import {
  CameraIcon,
  CheckIcon,
  CopyIcon,
  RefreshCwIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { isElectron } from "../../env";
import { hasMinesIdentityConfig } from "../../cloud/publicConfig";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useContacts } from "./ContactsProvider";

export function ContactAvatar({
  profile,
  large = false,
}: {
  readonly profile: ContactProfile;
  readonly large?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/70 bg-muted font-medium text-muted-foreground ${large ? "size-16 text-xl" : "size-9 text-sm"}`}
    >
      {profile.avatar && failed !== profile.avatar ? (
        <img
          src={profile.avatar}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(profile.avatar)}
        />
      ) : (
        profile.displayName.trim().slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

export function ContactsPageFrame({
  title,
  actions,
  children,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  useEscapeToGoBack();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        <div className="flex items-center gap-2">{actions}</div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer>{children}</WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}

export function ContactInvitationInbox() {
  const { data, busy, pending, mutate } = useContacts();
  if (!data) return null;
  const incoming = incomingContactInvitations(data);
  const outgoing = data.invitations.filter(
    (invite) => invite.status === "pending" && invite.inviter.friendId === data.profile.friendId,
  );
  return (
    <section aria-label="Group invitations" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">
        Invitations{" "}
        {incoming.length > 0 ? (
          <span className="text-muted-foreground">· {incoming.length}</span>
        ) : null}
      </h2>
      {incoming.length === 0 && outgoing.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pending invitations.</p>
      ) : null}
      {incoming.map((invite) => (
        <div
          key={invite.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 p-3"
        >
          <ContactAvatar profile={invite.inviter} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{invite.groupName}</p>
            <p className="text-xs text-muted-foreground">
              {invite.inviter.displayName} invited you
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || pending}
              onClick={() => void mutate((client) => client.respond(invite.id, "decline"))}
            >
              <XIcon />
              Decline
            </Button>
            <Button
              size="sm"
              disabled={busy || pending}
              onClick={() => void mutate((client) => client.respond(invite.id, "accept"))}
            >
              <CheckIcon />
              Accept
            </Button>
          </div>
        </div>
      ))}
      {outgoing.map((invite) => (
        <div
          key={invite.id}
          className="flex items-center gap-3 rounded-xl border border-border/70 p-3"
        >
          <ContactAvatar profile={invite.invitee} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{invite.groupName}</p>
            <p className="text-xs text-muted-foreground">
              Waiting for {invite.invitee.displayName}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={busy || pending}
            aria-label={`Cancel invitation to ${invite.invitee.displayName}`}
            onClick={() => void mutate((client) => client.respond(invite.id, "revoke"))}
          >
            <XIcon />
            Cancel
          </Button>
        </div>
      ))}
    </section>
  );
}

async function contactPhoto(file: File): Promise<string> {
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error("Choose a PNG, JPEG, WebP or GIF photo smaller than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your photo could not be opened.");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      64,
      64,
    );
    const avatar = canvas.toDataURL("image/jpeg", 0.8);
    if (avatar.length > CONTACT_AVATAR_MAX_BYTES) throw new Error("Choose a smaller photo.");
    return avatar;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ContactProfileEditor({ profile }: { readonly profile: ContactProfile }) {
  const { busy, pending, mutate } = useContacts();
  const { refreshSession } = useMinesAuth();
  const [name, setName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [photoPending, setPhotoPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "friend ID",
    onError: (cause) => setError(cause.message),
  });
  const changed = name.trim() !== profile.displayName || avatar !== profile.avatar;
  return (
    <section
      aria-label="Your contact profile"
      className="flex flex-col gap-4 rounded-2xl border border-border/70 p-5"
    >
      <div className="flex items-center gap-4">
        <ContactAvatar
          large
          profile={{ ...profile, displayName: name || profile.displayName, avatar }}
        />
        <div className="flex flex-col gap-2">
          <h2 className="font-medium">Your profile</h2>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || pending || photoPending}
              onClick={() => photoInput.current?.click()}
            >
              <CameraIcon />
              {photoPending ? "Opening photo…" : "Change photo"}
            </Button>
            {avatar ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={busy || pending || photoPending}
                onClick={() => setAvatar(null)}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
        <input
          ref={photoInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          aria-label="Profile photo"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            setPhotoPending(true);
            setError(null);
            void contactPhoto(file)
              .then(setAvatar, () =>
                setError(
                  "This photo could not be opened. Choose a PNG, JPEG, WebP or GIF photo smaller than 10 MB.",
                ),
              )
              .finally(() => setPhotoPending(false));
          }}
        />
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim())
            void mutate((client) =>
              client.updateProfile({ displayName: name.trim(), avatar }),
            ).then((saved) => {
              if (saved) {
                setName(saved.profile.displayName);
                setAvatar(saved.profile.avatar);
                void refreshSession().catch(() =>
                  setError("Profile saved. Refresh your account to update its photo."),
                );
              }
            });
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
          Display name
          <Input aria-label="Display name" maxLength={100} value={name} onValueChange={setName} />
        </label>
        <Button
          type="submit"
          variant="outline"
          disabled={!changed || !name.trim() || busy || pending || photoPending}
        >
          Save profile
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Your friend ID</span>
        <code className="break-all select-all text-foreground">{profile.friendId}</code>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={isCopied ? "Friend ID copied" : "Copy friend ID"}
          onClick={() => copyToClipboard(profile.friendId, undefined)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ManagedContactsPage() {
  const { data, signedIn, pending, busy, error, mutate, refresh } = useContacts();
  const { userId, openAccount } = useMinesAuth();
  const [friendDraft, setFriendDraft] = useState({ accountId: userId, value: "" });
  const friendId = friendDraft.accountId === userId ? friendDraft.value : "";
  const setFriendId = (value: string) => setFriendDraft({ accountId: userId, value });
  return (
    <ContactsPageFrame
      title="Contacts"
      actions={
        <>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Refresh contacts"
            disabled={pending || busy || !signedIn}
            onClick={refresh}
          >
            <RefreshCwIcon />
          </Button>
          <Button variant="outline" size="sm" render={<Link to="/shared-groups" />}>
            <UsersIcon />
            Workgroups
          </Button>
        </>
      }
    >
      {!signedIn ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">Sign in to add friends and share groups.</p>
          <Button onClick={openAccount}>Sign in to mines</Button>
        </div>
      ) : null}
      {pending && !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading contacts…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      ) : null}
      {data ? (
        <>
          <ContactProfileEditor key={`${userId}:${data.profile.friendId}`} profile={data.profile} />
          <ContactInvitationInbox />
          <section aria-label="Your contacts" className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-medium">
                Friends <span className="text-muted-foreground">· {data.contacts.length}</span>
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Add a friend using the ID from their Contacts page.
              </p>
            </div>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (friendId.trim())
                  void mutate((client) => client.addContact(friendId)).then((saved) => {
                    if (saved) setFriendId("");
                  });
              }}
            >
              <Input
                aria-label="Friend ID"
                placeholder="mines-…"
                value={friendId}
                maxLength={32}
                onValueChange={setFriendId}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" disabled={!friendId.trim() || busy || pending}>
                <UserPlusIcon />
                Add friend
              </Button>
            </form>
            {data.contacts.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">Your friends will appear here.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {data.contacts.map((contact) => (
                  <li key={contact.friendId} className="flex items-center gap-3 py-3">
                    <ContactAvatar profile={contact} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{contact.displayName}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {contact.friendId}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost-muted"
                      disabled={busy || pending}
                      aria-label={`Remove ${contact.displayName} from contacts`}
                      onClick={() =>
                        void mutate((client) => client.removeContact(contact.friendId))
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </ContactsPageFrame>
  );
}

export function ContactsPage() {
  return hasMinesIdentityConfig() ? (
    <ManagedContactsPage />
  ) : (
    <ContactsPageFrame title="Contacts">
      <p className="text-sm text-muted-foreground">
        Configure the mines account service to add contacts and share groups.
      </p>
    </ContactsPageFrame>
  );
}
