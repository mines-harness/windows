import { describe, expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { AuthAccessReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import type { PeerDevice } from "@t3tools/contracts/minesPeer";
import { createPeerIdentity } from "@t3tools/shared/minesPeerTrust";

type Presentation = { readonly connection: { readonly phase: "connected" | "offline" } };
type PeerState = { readonly device: PeerDevice; readonly approvedDevices: readonly PeerDevice[] };
const state = vi.hoisted(() => ({
  account: undefined as unknown as Atom.Writable<string | null>,
  presentations: undefined as unknown as Atom.Writable<ReadonlyMap<EnvironmentId, Presentation>>,
  sessions: new Map<
    EnvironmentId,
    Atom.Writable<AsyncResult.AsyncResult<AuthSessionState, Error>>
  >(),
  peers: new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<PeerState, Error>>>(),
  requests: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/catalog", () => ({
  get minesAccountIdAtom() {
    return state.account;
  },
}));
vi.mock("./presentation", () => ({
  environmentPresentations: {
    get presentationsAtom() {
      return state.presentations;
    },
  },
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)! },
}));
vi.mock("./peers", () => ({
  peerState: ({ environmentId }: { readonly environmentId: EnvironmentId }) => {
    state.requests(environmentId);
    return state.peers.get(environmentId)!;
  },
}));

import { environmentPeerDevicesAtom } from "./environmentPeerDevices";

const firstId = EnvironmentId.make("first");
const secondId = EnvironmentId.make("second");
const device = createPeerIdentity(new Uint8Array(32).fill(7), "Remote computer").device;
const granted: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthAccessReadScope],
  permissions: [AuthAccessReadScope],
};
function fixture() {
  state.requests.mockClear();
  state.account = Atom.make<string | null>("account-a");
  const presentations: ReadonlyMap<EnvironmentId, Presentation> = new Map([
    [firstId, { connection: { phase: "connected" } }],
  ]);
  state.presentations = Atom.make(presentations);
  state.sessions.clear();
  state.peers.clear();
  for (const id of [firstId, secondId]) {
    state.sessions.set(
      id,
      Atom.make<AsyncResult.AsyncResult<AuthSessionState, Error>>(AsyncResult.success(granted)),
    );
    state.peers.set(
      id,
      Atom.make<AsyncResult.AsyncResult<PeerState, Error>>(
        AsyncResult.success({ device, approvedDevices: [] }),
      ),
    );
  }
  const registry = AtomRegistry.make();
  registry.mount(environmentPeerDevicesAtom);
  return {
    registry,
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("environment peer identities", () => {
  it("reads only connected environments with the destination access grant", () => {
    using f = fixture();
    f.registry.set(
      state.presentations,
      new Map([
        [firstId, { connection: { phase: "connected" } }],
        [secondId, { connection: { phase: "offline" } }],
      ]),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    expect(state.requests.mock.calls.flat()).not.toContain(secondId);
    state.requests.mockClear();
    f.registry.set(
      state.sessions.get(firstId)!,
      AsyncResult.success({
        ...granted,
        permissions: [],
        scopes: [],
      }),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it("retains known offline identities and prunes removed environments", () => {
    using f = fixture();
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    state.requests.mockClear();
    f.registry.set(state.presentations, new Map([[firstId, { connection: { phase: "offline" } }]]));
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    expect(state.requests).not.toHaveBeenCalled();
    f.registry.set(state.presentations, new Map());
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
  });

  it("does not retain identities across account or session changes", () => {
    using f = fixture();
    expect(f.registry.get(environmentPeerDevicesAtom).get(firstId)).toEqual(device);
    f.registry.set(state.presentations, new Map([[firstId, { connection: { phase: "offline" } }]]));
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(1);
    f.registry.set(state.account, "account-b");
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
    f.registry.set(
      state.presentations,
      new Map([[firstId, { connection: { phase: "connected" } }]]),
    );
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(1);
    f.registry.set(state.presentations, new Map([[firstId, { connection: { phase: "offline" } }]]));
    f.registry.set(state.sessions.get(firstId)!, AsyncResult.success({ ...granted }));
    expect(f.registry.get(environmentPeerDevicesAtom).size).toBe(0);
  });
});
