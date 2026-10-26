import { describe, expect, it } from "vite-plus/test";
import {
  DesktopMenuBarState,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeThreadFixture } from "../../test-fixtures";
import { buildMenuBarState } from "./MenuBarCoordinator.logic";

const decodeMenuBarState = Schema.decodeUnknownSync(DesktopMenuBarState);

const activeRuntime = {
  status: "running" as const,
  activeRunId: RunId.make("run-1"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-10-25T00:00:00.000Z",
};

describe("menu bar activity", () => {
  it("prioritizes requests needing attention and excludes archived and idle threads", () => {
    const state = buildMenuBarState({
      threads: [
        makeThreadFixture({ id: ThreadId.make("running"), runtime: activeRuntime }),
        makeThreadFixture({ id: ThreadId.make("approval"), hasPendingApprovals: true }),
        makeThreadFixture({ id: ThreadId.make("idle") }),
        makeThreadFixture({
          id: ThreadId.make("archived"),
          hasPendingApprovals: true,
          archivedAt: "2026-10-25T00:00:00.000Z",
        }),
      ],
      providers: [],
      connectedDevices: 1,
      totalDevices: 2,
    });
    expect(state.running).toBe(1);
    expect(state.attention).toBe(1);
    expect(state.threads.map((thread) => thread.threadId)).toEqual(["approval", "running"]);
    expect(state.connectedDevices).toBe(1);
  });

  it("never represents missing or failed quota probes as exhausted accounts", () => {
    const state = buildMenuBarState({
      threads: [],
      connectedDevices: 1,
      totalDevices: 1,
      providers: [
        {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          auth: { status: "authenticated" },
        },
        {
          driver: ProviderDriverKind.make("claude"),
          enabled: true,
          auth: { status: "authenticated" },
          usageLimits: {
            checkedAt: "2026-10-25T00:00:00.000Z",
            unavailable: { reason: "probeFailed" },
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 }],
          },
        },
        {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          auth: { status: "authenticated", email: "pilot@example.com", label: "Personal" },
          displayName: "Work",
          usageLimits: {
            checkedAt: "2026-10-25T00:00:00.000Z",
            windows: [
              {
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: 25,
                resetsAt: "2026-10-25T01:00:00.000Z",
              },
              { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 92 },
            ],
          },
        },
      ],
    });
    expect(state.limits.map((limit) => limit.remainingPercent)).toEqual([null, null, 8]);
    expect(state.limits[2]).toMatchObject({
      driver: "codex",
      accountLabel: "pilot@example.com",
      checkedAt: "2026-10-25T00:00:00.000Z",
      windows: [
        {
          id: "session",
          label: "Session",
          remainingPercent: 75,
          resetsAt: "2026-10-25T01:00:00.000Z",
        },
        { id: "weekly", label: "Weekly", remainingPercent: 8 },
      ],
    });
    expect(state.limits[0]?.windows).toEqual([]);
    expect(state.limits[1]?.windows?.[0]?.remainingPercent).toBeNull();
  });

  it("shows only authenticated enabled accounts and preserves an exhausted account as zero", () => {
    const state = buildMenuBarState({
      threads: [],
      connectedDevices: 1,
      totalDevices: 1,
      providers: [
        {
          driver: ProviderDriverKind.make("claude"),
          enabled: true,
          auth: { status: "unauthenticated" },
        },
        { driver: ProviderDriverKind.make("claude"), enabled: true, auth: { status: "unknown" } },
        {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          auth: { status: "authenticated" },
        },
        {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          auth: { status: "authenticated", label: "Work account" },
          usageLimits: {
            checkedAt: "2026-10-25T00:00:00.000Z",
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
          },
        },
      ],
      devices: [{ id: "local", name: "This Mac", connected: true, local: true }],
    });
    expect(state.limits).toHaveLength(1);
    expect(state.limits[0]).toMatchObject({
      driver: "codex",
      accountLabel: "Work account",
      remainingPercent: 0,
    });
    expect(state.limits[0]?.windows?.[0]?.remainingPercent).toBe(0);
    expect(state.devices).toEqual([
      { id: "local", name: "This Mac", connected: true, local: true },
    ]);
    expect(decodeMenuBarState(state)).toEqual(state);
  });

  it("accepts an older menu bar IPC snapshot without optional rich panel data", () => {
    const state = {
      running: 0,
      attention: 0,
      connectedDevices: 0,
      totalDevices: 0,
      threads: [],
      limits: [{ label: "Codex", remainingPercent: null, checkedAt: "" }],
    };
    expect(decodeMenuBarState(state)).toEqual(state);
  });

  it("keeps account discovery and approval separate from a connected session", () => {
    const state = buildMenuBarState({
      threads: [],
      providers: [],
      connectedDevices: 0,
      totalDevices: 1,
      devices: [
        {
          id: "device:ovh",
          name: "OVH",
          connected: false,
          local: false,
          status: "needs-approval",
          presence: "online",
        },
      ],
    });
    expect(state.connectedDevices).toBe(0);
    expect(decodeMenuBarState(state).devices).toEqual([
      {
        id: "device:ovh",
        name: "OVH",
        connected: false,
        local: false,
        status: "needs-approval",
        presence: "online",
      },
    ]);
  });
});
