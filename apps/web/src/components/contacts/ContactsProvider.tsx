import type { ContactsSnapshot } from "@t3tools/contracts/contacts";
import {
  createContactsClient,
  incomingContactInvitations,
  type ContactsClient,
} from "@t3tools/shared/minesContacts";
import { createContext, use, useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { minesControlUrl } from "../../cloud/publicConfig";

interface ContactsState {
  readonly key: string;
  readonly api: ContactsClient;
  readonly requestKey: string;
  readonly data: ContactsSnapshot | null;
  readonly error: string | null;
  readonly busy: boolean;
}
interface ContactsContextValue {
  readonly data: ContactsSnapshot | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly signedIn: boolean;
  readonly refresh: () => void;
  readonly mutate: (
    action: (client: ContactsClient) => Promise<ContactsSnapshot>,
  ) => Promise<ContactsSnapshot | null>;
}
const ContactsContext = createContext<ContactsContextValue | null>(null);

export function ContactsProvider({ children }: { readonly children: ReactNode }) {
  const { isSignedIn, userId, getToken } = useMinesAuth();
  const accountId = isSignedIn ? userId : null;
  const controlUrl = minesControlUrl();
  const key = JSON.stringify([accountId, controlUrl]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ContactsState | null>(null);
  const requestKey = JSON.stringify([key, revision]);
  const refreshOnFocus = useEffectEvent(() => {
    if (!state?.busy) setRevision((value) => value + 1);
  });
  useEffect(() => {
    if (!accountId || !controlUrl) return;
    let active = true;
    const client = createContactsClient({ controlUrl, getToken, isCurrent: () => active });
    void client.snapshot().then(
      (data) => {
        if (active)
          setState({
            key,
            api: client,
            requestKey,
            data,
            error: null,
            busy: false,
          });
      },
      (error: unknown) => {
        if (active)
          setState((previous) => ({
            key,
            api: client,
            requestKey,
            data: previous?.key === key ? previous.data : null,
            busy: false,
            error: error instanceof Error ? error.message : "Contacts could not be loaded.",
          }));
      },
    );
    const refresh = () => refreshOnFocus();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [accountId, controlUrl, getToken, key, requestKey]);
  const current = state?.key === key ? state : null;
  const pending = accountId !== null && controlUrl !== null && current?.requestKey !== requestKey;
  const mutate: ContactsContextValue["mutate"] = async (action) => {
    if (!current || current.busy || pending) return null;
    const client = current.api;
    setState((previous) =>
      previous?.api === client ? { ...previous, busy: true, error: null } : previous,
    );
    try {
      const data = await action(client);
      setState((previous) =>
        previous?.api === client ? { ...previous, data, busy: false } : previous,
      );
      return data;
    } catch (error) {
      setState((previous) =>
        previous?.api === client
          ? {
              ...previous,
              busy: false,
              error: error instanceof Error ? error.message : "Contacts could not be updated.",
            }
          : previous,
      );
      return null;
    }
  };
  return (
    <ContactsContext
      value={{
        data: current?.data ?? null,
        error: current?.error ?? null,
        pending,
        busy: current?.busy ?? false,
        signedIn: accountId !== null,
        refresh: () => setRevision((value) => value + 1),
        mutate,
      }}
    >
      {children}
    </ContactsContext>
  );
}
export function useContacts() {
  const value = use(ContactsContext);
  if (!value) throw new Error("Contacts require ContactsProvider.");
  return value;
}
export function useContactInvitationCount() {
  const value = use(ContactsContext);
  return value?.data ? incomingContactInvitations(value.data).length : 0;
}

export function useContactGroupsSnapshot() {
  return use(ContactsContext)?.data ?? null;
}
