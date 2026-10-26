// @effect-diagnostics globalDate:off
// Native date formatting keeps this sandboxed renderer independent of the Effect runtime.
import { ipcRenderer } from "electron";
import type { DesktopMenuBarState } from "@t3tools/contracts";
import {
  GET_MENU_BAR_STATE_CHANNEL,
  MENU_BAR_ACTION_CHANNEL,
  MENU_BAR_STATE_CHANNEL,
} from "./ipc/channels.ts";

window.addEventListener("DOMContentLoaded", () => {
  const element = <K extends keyof HTMLElementTagNameMap>(id: string, tag: K) => {
    const node = document.getElementById(id);
    if (!node || node.tagName.toLowerCase() !== tag)
      throw new Error(`Missing menu bar element: ${id}`);
    return node as HTMLElementTagNameMap[K];
  };
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const text = (id: string, value: string) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  const action = (value: string) => {
    void ipcRenderer.invoke(MENU_BAR_ACTION_CHANNEL, value).catch(() => undefined);
  };
  const percent = (value: number | null) => (value === null ? "?" : `${Math.round(value)}%`);
  const color = (value: number | null) =>
    value === null ? "#85858f" : value <= 5 ? "#f09b95" : value <= 20 ? "#e7c17c" : "#b5ed93";
  const date = (value: string) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  };
  const time = (value: Date) =>
    value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const timestamp = (value: Date) =>
    value.toLocaleDateString() === new Date().toLocaleDateString()
      ? time(value)
      : value.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  let state: DesktopMenuBarState | null = null;
  let activityFilter: "working" | "attention" | null = null;

  const selectTab = (selected: "overview" | "devices") => {
    for (const name of ["overview", "devices"] as const) {
      const tab = element(`${name}-tab`, "button");
      tab.setAttribute("aria-selected", String(name === selected));
      tab.tabIndex = name === selected ? 0 : -1;
      element(name, "section").hidden = name !== selected;
    }
  };
  for (const name of ["overview", "devices"] as const) {
    const tab = element(`${name}-tab`, "button");
    tab.addEventListener("click", () => selectTab(name));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const target =
        event.key === "Home"
          ? "overview"
          : event.key === "End"
            ? "devices"
            : name === "overview"
              ? "devices"
              : "overview";
      selectTab(target);
      element(`${target}-tab`, "button").focus();
    });
  }
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => action(button.dataset.action ?? "close"));
  });
  document.querySelector("[data-tab='devices']")?.addEventListener("click", () => {
    selectTab("devices");
    element("devices-tab", "button").focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") action("close");
  });

  const renderActivity = () => {
    const list = element("active-mines", "div");
    list.replaceChildren();
    text("running-count", state ? String(state.running) : "?");
    text("attention-count", state ? String(state.attention) : "?");
    text(
      "activity-label",
      activityFilter === "working"
        ? "Running mines"
        : activityFilter === "attention"
          ? "Needs your input"
          : "Your workspace",
    );
    element("running-filter", "button").setAttribute(
      "aria-pressed",
      String(activityFilter === "working"),
    );
    element("attention-filter", "button").setAttribute(
      "aria-pressed",
      String(activityFilter === "attention"),
    );
    const threads =
      state?.threads.filter((thread) => !activityFilter || thread.status === activityFilter) ?? [];
    if (!threads.length) {
      const hasMore =
        state !== null &&
        (activityFilter === "working"
          ? state.running
          : activityFilter === "attention"
            ? state.attention
            : state.running + state.attention) > 0;
      const empty = make("div", "empty-activity");
      const mine = make("img");
      mine.src = "../startup/mine.png";
      mine.alt = "";
      mine.width = 15;
      mine.height = 15;
      empty.append(
        mine,
        make(
          "span",
          "",
          hasMore
            ? "Open the app to see more active mines"
            : state
              ? activityFilter === "attention"
                ? "Nothing needs your attention"
                : activityFilter === "working"
                  ? "No mines running"
                  : "No active mines"
              : "Connecting to your workspace…",
        ),
      );
      if (hasMore) {
        const open = make("button", "text-button", "Open app ↗");
        open.addEventListener("click", () => action("open"));
        empty.append(open);
      }
      list.append(empty);
      return;
    }
    for (const thread of threads) {
      const row = make("button", "mine-row");
      const icon = make("img");
      icon.src = thread.status === "attention" ? "flag.svg" : "../startup/mine.png";
      icon.width = 16;
      icon.height = 16;
      icon.alt = "";
      const label = make("span");
      label.append(
        make("strong", "", thread.title || "Untitled mine"),
        make("small", "", thread.status === "attention" ? "Needs your attention" : "Working"),
      );
      row.append(icon, label, make("span", "arrow", "↗"));
      row.addEventListener("click", () =>
        action(
          `mines:thread:${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
        ),
      );
      list.append(row);
    }
  };
  for (const [id, filter] of [
    ["running-filter", "working"],
    ["attention-filter", "attention"],
  ] as const) {
    element(id, "button").addEventListener("click", () => {
      activityFilter = activityFilter === filter ? null : filter;
      renderActivity();
    });
  }

  const openAccounts = new Set<string>();
  const usageTrack = (remaining: number | null, label: string) => {
    const track = make("div", "window-track");
    if (remaining !== null) {
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-label", label);
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(Math.round(remaining)));
    }
    const fill = make("span", "window-fill");
    fill.style.width = `${remaining ?? 0}%`;
    fill.style.background = color(remaining);
    track.append(fill);
    return track;
  };
  const renderQuota = () => {
    const limits = state?.limits ?? [];
    const list = element("account-usage", "div");
    const focusedAccount = document.activeElement?.closest<HTMLDetailsElement>(
      "details[data-account-key]",
    )?.dataset.accountKey;
    list.replaceChildren();
    if (!limits.length) {
      list.append(
        make(
          "p",
          "no-accounts",
          state ? "Connect an account to see its usage here." : "Checking your connected accounts…",
        ),
      );
      return;
    }
    for (const [index, limit] of limits.entries()) {
      const key = `${index}/${limit.driver ?? ""}/${limit.label}/${limit.accountLabel ?? ""}`;
      const details = make("details", "usage-account");
      details.dataset.accountKey = key;
      details.open = openAccounts.has(key);
      details.addEventListener("toggle", () => {
        if (details.open) openAccounts.add(key);
        else openAccounts.delete(key);
      });
      const summary = make("summary");
      summary.setAttribute(
        "aria-label",
        `${limit.label} usage: ${limit.remainingPercent === null ? "unavailable" : `${percent(limit.remainingPercent)} remaining`}`,
      );
      const icon = make("img", "provider-icon");
      icon.src =
        limit.driver === "codex"
          ? "codex.svg"
          : limit.driver === "claudeAgent" || limit.driver === "claude"
            ? "claude.svg"
            : "../startup/mine.png";
      icon.alt = limit.label;
      const windows = limit.windows ?? [];
      const limitingWindow = windows.toSorted(
        (a, b) => (a.remainingPercent ?? 101) - (b.remainingPercent ?? 101),
      )[0];
      const info = make("span", "usage-summary");
      const line = make("span", "usage-line");
      line.append(
        make(
          "strong",
          "",
          limit.remainingPercent === null
            ? "Usage unavailable"
            : `${percent(limit.remainingPercent)} left`,
        ),
        make("small", "", limitingWindow?.label ?? "Allowance"),
      );
      info.append(line, usageTrack(limit.remainingPercent, `${limit.label} allowance remaining`));
      const chevron = make("span", "usage-chevron", "⌄");
      chevron.setAttribute("aria-hidden", "true");
      summary.append(icon, info, chevron);
      const content = make("div", "usage-details");
      if (limit.accountLabel) content.append(make("p", "account-identity", limit.accountLabel));
      const windowList = make("div", "quota-windows");
      for (const window of windows) {
        const row = make("div");
        const heading = make("div", "window-heading");
        heading.append(
          make("strong", "", window.label),
          make(
            "span",
            "",
            window.remainingPercent === null
              ? "Unavailable"
              : `${percent(window.remainingPercent)} left`,
          ),
        );
        row.append(heading, usageTrack(window.remainingPercent, `${window.label} remaining`));
        const reset = window.resetsAt ? date(window.resetsAt) : null;
        if (reset)
          row.append(
            make(
              "p",
              "window-reset",
              reset.getTime() <= Date.now()
                ? "Reset due · awaiting an update"
                : `Resets ${timestamp(reset)}`,
            ),
          );
        windowList.append(row);
      }
      content.append(windowList);
      const checked = limit.checkedAt ? date(limit.checkedAt) : null;
      content.append(
        make(
          "p",
          "usage-reported",
          checked ? `Reported ${timestamp(checked)}` : "No usage report yet",
        ),
      );
      details.append(summary, content);
      list.append(details);
      if (focusedAccount === key) summary.focus({ preventScroll: true });
    }
  };

  const renderDevices = () => {
    const count = state?.connectedDevices ?? 0;
    text("device-count", state ? String(count) : "?");
    text(
      "connection-label",
      state ? `${count} device${count === 1 ? "" : "s"} connected` : "Connecting",
    );
    element("connection-dot", "i").style.background = count ? "#b5ed93" : "#85858f";
    text(
      "connection-summary",
      state ? `${count} of ${state.totalDevices} connected` : "Checking connections",
    );
    const list = element("device-list", "div");
    list.replaceChildren();
    for (const device of state?.devices ?? []) {
      const row = make("div", "device-row");
      const info = make("div", "device-info");
      info.append(
        make("strong", "", device.name || "Unnamed device"),
        make(
          "small",
          "",
          [
            ...(device.local ? ["This computer"] : []),
            device.status
              ? {
                  connected: "Connected",
                  connecting: "Connecting…",
                  "not-connected": "Not connected",
                  disabled: "Disabled",
                  unavailable: "Connection unavailable",
                  "needs-approval": "Needs approval",
                }[device.status]
              : device.connected
                ? "Connected"
                : "Not connected",
            ...(device.presence && !device.connected
              ? [
                  {
                    online: "Online",
                    offline: "Offline",
                    unknown: "Availability unknown",
                  }[device.presence],
                ]
              : []),
          ].join(" · "),
        ),
      );
      const status = make("span", "device-state");
      status.style.background = device.connected
        ? "#b5ed93"
        : device.presence === "online"
          ? "#8bbcff"
          : "#686871";
      status.title = device.connected
        ? "Connected"
        : device.presence === "online"
          ? "Online for discovery"
          : device.presence === "offline"
            ? "Offline"
            : "Availability unknown";
      row.append(make("span", "device-glyph"), info, status);
      list.append(row);
    }
    if (!list.childElementCount)
      list.append(
        make("p", "empty-activity", state ? "No devices available" : "Checking your devices…"),
      );
  };

  const render = (next: DesktopMenuBarState | null) => {
    const react =
      state !== null &&
      next !== null &&
      (next.running > state.running || next.attention > state.attention);
    state = next;
    text(
      "workspace-title",
      !state
        ? "Your workspace."
        : state.attention
          ? "Your mines need you."
          : state.running
            ? "Work is underway."
            : "Ready when you are.",
    );
    text(
      "workspace-subtitle",
      !state
        ? "Connecting to your agents…"
        : state.attention
          ? "An approval or reply is waiting for you."
          : state.running
            ? "Your agents are making progress."
            : "Start something new. We'll keep you in the loop.",
    );
    renderQuota();
    renderActivity();
    renderDevices();
    if (react && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element("workspace-mine", "img").animate(
        [
          { transform: "none" },
          { transform: "translateY(-4px) rotate(-12deg)", offset: 0.28 },
          { transform: "rotate(9deg)", offset: 0.65 },
          { transform: "none" },
        ],
        { duration: 360, easing: "ease-out" },
      );
    }
  };
  let receivedLiveState = false;
  ipcRenderer.on(MENU_BAR_STATE_CHANNEL, (_event, next: DesktopMenuBarState) => {
    receivedLiveState = true;
    render(next);
  });
  void ipcRenderer
    .invoke(GET_MENU_BAR_STATE_CHANNEL)
    .then((initial: DesktopMenuBarState | null) => {
      if (!receivedLiveState) render(initial);
    })
    .catch(() => text("account-label", "Reopen this panel to reconnect"));
});
