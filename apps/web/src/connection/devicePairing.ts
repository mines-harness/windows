import {
  beginDevicePairing,
  cancelDevicePairing,
  collectDevicePairing,
} from "@t3tools/shared/minesDevicePairing";
import { makeDevicePairingAdapter } from "./devicePairing.logic";
import { loadBrowserPeerIdentity, pairBrowserPeer } from "./peerPairing";

const pairing = makeDevicePairingAdapter({
  identity: loadBrowserPeerIdentity,
  begin: beginDevicePairing,
  collect: collectDevicePairing,
  cancel: cancelDevicePairing,
  pair: pairBrowserPeer,
  nowSeconds: () => Math.floor(Date.now() / 1000),
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- Signed device requests require a synchronous nonce callback.
  randomId: () => crypto.randomUUID(),
});

export const selectDevicePairingAccount = pairing.selectAccount;
export const beginBrowserDevicePairing = pairing.begin;
export const collectBrowserDevicePairing = pairing.collect;
export const cancelBrowserDevicePairing = pairing.cancel;
export type {
  BeginPeerPairingInput,
  CancelPeerPairingInput,
  CollectPeerPairingInput,
  PeerPairingProgress,
  PeerPairingRequest,
} from "./devicePairing.logic";
