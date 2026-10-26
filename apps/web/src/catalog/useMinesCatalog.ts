import { PeerConnections } from "@t3tools/client-runtime/peer";
import { bindCatalogSession } from "@t3tools/client-runtime/catalog/peer";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  minesAccountIdAtom,
  registerCatalogExecutionSource,
} from "@t3tools/client-runtime/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { openPersistedCatalog } from "@t3tools/client-runtime/catalog/persistence";
import type { MinesCatalog, MinesCatalogSnapshot } from "@t3tools/client-runtime/catalog";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createBrowserCatalogStorage } from "./storage";

const peersAtom = connectionAtomRuntime.atom(PeerConnections);

const catalogs = new Map<string, ReturnType<typeof openPersistedCatalog>>();
const EMPTY: MinesCatalogSnapshot = { version: 0, roots: [], pins: [], entities: [] };
const noSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
const noError = () => null;
type Handle = Awaited<ReturnType<typeof openPersistedCatalog>>;

export function openBrowserCatalog(accountId: string) {
  const existing = catalogs.get(accountId);
  if (existing) return existing;
  const pending = createBrowserCatalogStorage(accountId).then((storage) =>
    openPersistedCatalog({ storage }),
  );
  catalogs.set(accountId, pending);
  void pending.catch(() => {
    catalogs.delete(accountId);
  });
  return pending;
}

export function useMinesCatalog() {
  const peerResult = useAtomValue(peersAtom);
  const peers = Option.getOrNull(AsyncResult.value(peerResult));
  const accountId = useAtomValue(minesAccountIdAtom) ?? "local-device";
  const [state, setState] = useState<{
    accountId: string;
    catalog: MinesCatalog | null;
    handle?: Handle;
    error: string | null;
  }>({ accountId, catalog: null, error: null });
  useEffect(() => {
    let cancelled = false;
    void openBrowserCatalog(accountId)
      .then((handle) => {
        if (!cancelled) setState({ accountId, catalog: handle.catalog, handle, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            accountId,
            catalog: null,
            error: error instanceof Error ? error.message : "Could not open the sidebar.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  const catalog = state.accountId === accountId ? state.catalog : null;
  useEffect(() => {
    if (!catalog || !peers || accountId === "local-device") return;
    const stops = new Set<() => void>();
    const unsubscribe = peers.subscribeSessions((peer) => {
      const stop = bindCatalogSession(catalog, accountId, peer);
      stops.add(stop);
      void peer.closed.then(() => {
        stop();
        stops.delete(stop);
      });
    });
    return () => {
      unsubscribe();
      for (const stop of stops) stop();
    };
  }, [catalog, peers, accountId]);
  const handle = state.accountId === accountId ? state.handle : undefined;
  useEffect(() => {
    if (!catalog || !handle) return;
    return registerCatalogExecutionSource(appAtomRegistry, accountId, catalog, handle.flush);
  }, [accountId, catalog, handle]);
  const persistenceError = useSyncExternalStore(
    handle?.subscribePersistence ?? noSubscribe,
    handle?.getPersistenceError ?? noError,
    noError,
  );
  const snapshot = useSyncExternalStore(
    catalog?.subscribe ?? noSubscribe,
    catalog?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return {
    catalog,
    snapshot,
    flush: async () => {
      if (!handle) throw new Error("The library is not ready to save changes.");
      await handle.flush();
    },
    accountId,
    error: persistenceError ?? (state.accountId === accountId ? state.error : null),
  };
}
