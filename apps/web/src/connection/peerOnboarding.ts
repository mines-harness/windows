import {
  minesAccountIdAtom,
  minesAccountEnvironmentIdsAtom,
} from "@t3tools/client-runtime/catalog";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { connectionAtomRuntime } from "./runtime";
import {
  beginBrowserDevicePairing,
  cancelBrowserDevicePairing,
  collectBrowserDevicePairing,
  selectDevicePairingAccount,
  type BeginPeerPairingInput,
  type CancelPeerPairingInput,
  type CollectPeerPairingInput,
} from "./devicePairing";
import {
  browserPeerApproval,
  forgetBrowserPeer,
  listBrowserPeerRoutes,
  pairBrowserPeer,
  restoreBrowserPeers,
} from "./peerPairing";

const scheduler = createAtomCommandScheduler();
const common = { scheduler, concurrency: { mode: "serial", key: () => "peer" } } as const;
export const peerClientApproval = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:approval",
  execute: browserPeerApproval,
});
export const peerClientRoutes = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:routes",
  execute: listBrowserPeerRoutes,
});
export const restorePeerClient = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:restore",
  execute: Effect.fn("web.peer.restoreCommand")(function* (accountId: string | null) {
    yield* selectDevicePairingAccount(accountId);
    return yield* restoreBrowserPeers(accountId);
  }),
});
export const beginPeerPairing = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:pairing:begin",
  execute: Effect.fn("web.peer.beginPairingCommand")(function* (
    input: BeginPeerPairingInput,
    registry: AtomRegistry.AtomRegistry,
  ) {
    yield* selectDevicePairingAccount(registry.get(minesAccountIdAtom));
    return yield* beginBrowserDevicePairing(
      input,
      () => registry.get(minesAccountIdAtom) === input.accountId,
    );
  }),
});
export const collectPeerPairing = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:pairing:collect",
  execute: Effect.fn("web.peer.collectPairingCommand")(function* (
    input: CollectPeerPairingInput,
    registry: AtomRegistry.AtomRegistry,
  ) {
    const result = yield* collectBrowserDevicePairing(
      input,
      () => registry.get(minesAccountIdAtom) === input.accountId,
    );
    if (result.status === "connected" && registry.get(minesAccountIdAtom) === input.accountId)
      registry.set(
        minesAccountEnvironmentIdsAtom,
        new Set([...registry.get(minesAccountEnvironmentIdsAtom), result.environmentId]),
      );
    return result;
  }),
});
export const cancelPeerPairing = createRuntimeCommand(connectionAtomRuntime, {
  scheduler,
  concurrency: { mode: "parallel" },
  label: "web:peer:pairing:cancel",
  execute: (input: CancelPeerPairingInput) => cancelBrowserDevicePairing(input),
});
export const pairPeerClient = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:pair",
  execute: Effect.fn("web.peer.pairCommand")(function* (
    input: Parameters<typeof pairBrowserPeer>[0],
    registry: AtomRegistry.AtomRegistry,
  ) {
    const environmentId = yield* pairBrowserPeer(input);
    if (registry.get(minesAccountIdAtom) === input.accountId)
      registry.set(
        minesAccountEnvironmentIdsAtom,
        new Set([...registry.get(minesAccountEnvironmentIdsAtom), environmentId]),
      );
    return environmentId;
  }),
});
export const forgetPeerClient = createRuntimeCommand(connectionAtomRuntime, {
  ...common,
  label: "web:peer:forget",
  execute: Effect.fn("web.peer.forgetCommand")(function* (
    input: Parameters<typeof forgetBrowserPeer>[0],
    registry: AtomRegistry.AtomRegistry,
  ) {
    const allowed = yield* forgetBrowserPeer(input);
    if (registry.get(minesAccountIdAtom) === input.accountId)
      registry.set(minesAccountEnvironmentIdsAtom, new Set(allowed));
  }),
});
