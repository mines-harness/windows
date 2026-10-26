import type { PeerDeviceDirectory } from "@t3tools/contracts/minesPeer";

export interface AccountPeerDirectoryRequest {
  readonly accountId: string | null;
  readonly controlUrl: string | null;
  readonly requestKey: string;
}

export interface AccountPeerDirectoryState extends AccountPeerDirectoryRequest {
  readonly data: PeerDeviceDirectory | null;
  readonly error: string | null;
}

export function readAccountPeerDirectory(
  state: AccountPeerDirectoryState,
  request: AccountPeerDirectoryRequest,
) {
  const enabled = request.accountId !== null && request.controlUrl !== null;
  const current =
    enabled && state.accountId === request.accountId && state.controlUrl === request.controlUrl
      ? state
      : null;
  const isPending = enabled && current?.requestKey !== request.requestKey;
  return {
    data: current?.data ?? null,
    isPending,
    error: isPending ? null : (current?.error ?? null),
  };
}

export function failAccountPeerDirectory(
  previous: AccountPeerDirectoryState,
  request: AccountPeerDirectoryRequest,
  error: string,
): AccountPeerDirectoryState {
  const data = readAccountPeerDirectory(previous, request).data;
  return { ...request, data: data ? { ...data, presence: [] } : null, error };
}
