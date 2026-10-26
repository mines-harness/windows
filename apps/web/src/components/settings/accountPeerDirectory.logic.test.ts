import type { PeerDeviceDirectory } from "@t3tools/contracts/minesPeer";
import { expect, it } from "vite-plus/test";

import {
  failAccountPeerDirectory,
  readAccountPeerDirectory,
  type AccountPeerDirectoryState,
} from "./accountPeerDirectory.logic";

function loadedDirectory(): AccountPeerDirectoryState {
  const data: PeerDeviceDirectory = {
    devices: [{ deviceId: "ovh-device-123456", publicKey: "a".repeat(43), label: "OVH" }],
    presence: [{ deviceId: "ovh-device-123456", online: true }],
  };
  return {
    accountId: "account-a",
    controlUrl: "https://mines.example.test",
    requestKey: "request-1",
    data,
    error: null,
  };
}

it("keeps the same account's devices visible while refreshing", () => {
  const state = loadedDirectory();
  const view = readAccountPeerDirectory(state, { ...state, requestKey: "request-2" });
  expect(view).toEqual({ data: state.data, isPending: true, error: null });
});

it("retains known devices after refresh failure without keeping stale presence", () => {
  const state = loadedDirectory();
  const request = { ...state, requestKey: "request-2" };
  const failed = failAccountPeerDirectory(state, request, "Unable to refresh devices.");
  const view = readAccountPeerDirectory(failed, request);
  expect(view).toEqual({
    data: { devices: state.data?.devices, presence: [] },
    isPending: false,
    error: "Unable to refresh devices.",
  });
  const retry = readAccountPeerDirectory(failed, { ...request, requestKey: "request-3" });
  expect(retry).toEqual({ data: view.data, isPending: true, error: null });
});

it("never reveals cached devices to another account, account service, or signed-out session", () => {
  const state = loadedDirectory();
  for (const request of [
    { ...state, accountId: "account-b", requestKey: "request-2" },
    { ...state, controlUrl: "https://other.example.test", requestKey: "request-2" },
    { ...state, accountId: null, requestKey: "request-2" },
  ]) {
    expect(readAccountPeerDirectory(state, request).data).toBeNull();
    const failed = failAccountPeerDirectory(state, request, "Unable to refresh devices.");
    expect(readAccountPeerDirectory(failed, request).data).toBeNull();
  }
});
