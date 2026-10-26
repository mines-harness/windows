import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const peerState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:peer:state",
  tag: WS_METHODS.peerGetState,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});

export const peerConnectionState = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:peer:connection",
  tag: WS_METHODS.peerConnectionState,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});

export const peerStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:peer:status",
  tag: WS_METHODS.peerStatus,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});

export const peerCheckDevice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:check-device",
  tag: WS_METHODS.peerCheckDevice,
});

export const peerPairingRequests = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mines:peer:pairing-requests",
  tag: WS_METHODS.peerPairingRequests,
  staleTimeMs: 10_000,
  idleTtlMs: 30_000,
});

export const peerApprovePairing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:approve-pairing",
  tag: WS_METHODS.peerApprovePairing,
});

export const peerDenyPairing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:deny-pairing",
  tag: WS_METHODS.peerDenyPairing,
});

export const peerConfigure = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:configure",
  tag: WS_METHODS.peerConfigure,
});

export const peerDisable = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:disable",
  tag: WS_METHODS.peerDisable,
});

export const peerApprove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:approve",
  tag: WS_METHODS.peerApprove,
});

export const peerRevoke = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:revoke",
  tag: WS_METHODS.peerRevoke,
});

export const readPeerConnectionState = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mines:peer:connection:read",
  tag: WS_METHODS.peerConnectionState,
});
