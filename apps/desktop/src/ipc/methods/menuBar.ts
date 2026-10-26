import { DesktopMenuBarState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as NodeEvents from "node:events";

import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  GET_MENU_BAR_STATE_CHANNEL,
  MENU_BAR_ACTION_CHANNEL,
  MENU_BAR_STATE_CHANNEL,
  SET_MENU_BAR_STATE_CHANNEL,
  SHOW_MENU_BAR_EVENT,
} from "../channels.ts";
import { isMenuBarActionAllowed, menuBarPanelBounds, menuBarTitle } from "./menuBar.logic.ts";

const TEMPLATE_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAAkElEQVR4nO3VwQqFMAxE0f7/T9eNKyntRJMhI3PBlcWc4OM5hnPOuT8270umCLh0sQgCOVv+JjIhkwlGMV+fkxIybHefil0NfXvRk8KuwLt7LdAGs8Htf8dtwRl/YdRF5MBVi9Az2OBEsBSWjn4OjSKpaHTY6QwNjQ6JLFX+sUDPZS1GKQKRA7dIDuyccw7rApG7SsS+NAYIAAAAAElFTkSuQmCC";
const COLOR_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjElEQVR4nO3SsQqAMAwE0Pz/4Lf4WW46uFcQBBXaJtdrI5LhFiPJg56ISHJOAALQb/m0zI/QAdu+ninNmwG1A7n5NaMAakdy36mA0iHt/3AH7ku1MXTJVjjycQygQf0bMKQDSPFA0EcB7k8QgNY+0ADvpR0QOoBlZkTUAUwcXELkiDuA0oEBCUAAfAEHRYhKTiTNz8QAAAAASUVORK5CYII=";

class MenuBarRequestRejected extends Schema.TaggedError<MenuBarRequestRejected>()(
  "MenuBarRequestRejected",
  {},
) {
  override get message(): string {
    return "The menu bar request was rejected.";
  }
}

export const installMenuBar = Effect.fn("desktop.ipc.installMenuBar")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const platform = yield* HostProcess.Platform;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const assets = yield* DesktopAssets.DesktopAssets;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const icon = Electron.nativeImage
    .createFromBuffer(Buffer.from(platform === "darwin" ? TEMPLATE_ICON : COLOR_ICON, "base64"))
    .resize({ width: 22, height: 22 });
  icon.setTemplateImage(platform === "darwin");
  const tray = yield* Effect.acquireRelease(
    Effect.sync(() => new Electron.Tray(icon)),
    (resource) => Effect.sync(() => resource.destroy()),
  );
  let state: DesktopMenuBarState | null = null;
  let popup: Electron.BrowserWindow | null = null;
  let opening = false;
  let disposed = false;
  let animation: AbortController | null = null;
  const closePopup = () => {
    const window = popup;
    popup = null;
    if (window && !window.isDestroyed()) window.destroy();
  };
  const dispatch = (action: string) => {
    closePopup();
    void runPromise(desktopWindow.dispatchMenuAction(action, { reveal: true }).pipe(Effect.ignore));
  };
  const buildMenu = () =>
    Electron.Menu.buildFromTemplate([
      {
        label: "Open mines",
        click: () => {
          closePopup();
          void runPromise(desktopWindow.activate.pipe(Effect.ignore));
        },
      },
      { type: "separator" },
      {
        label: state
          ? `${state.running} running · ${state.attention} need attention`
          : "Connecting to your workspace…",
        enabled: false,
      },
      {
        label: state
          ? `${state.connectedDevices} of ${state.totalDevices} devices connected`
          : "Checking device connections…",
        enabled: false,
      },
      ...(state?.threads ?? []).map((thread) => ({
        label: `${thread.status === "attention" ? "!" : "•"} ${thread.title || "Untitled mine"}`,
        click: () =>
          dispatch(
            `mines:thread:${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
          ),
      })),
      { type: "separator" },
      ...(state?.limits ?? []).map((limit) => ({
        label: `${limit.label}${limit.accountLabel ? ` · ${limit.accountLabel}` : ""}: ${limit.remainingPercent === null ? "usage unavailable" : `${Math.round(limit.remainingPercent)}% remaining`}`,
        click: () => dispatch("mines:accounts"),
      })),
      { label: "Manage accounts…", click: () => dispatch("mines:accounts") },
      { label: "Manage devices…", click: () => dispatch("mines:devices") },
      { type: "separator" },
      { label: "Quit mines", role: "quit" },
    ]);
  const iconBitmap = icon.toBitmap();
  const jiggleFrames = [-1, 1, 0].map((offset) => {
    const bitmap = Buffer.alloc(iconBitmap.length);
    for (let row = 0; row < 22; row++) {
      const start = row * 22 * 4;
      iconBitmap.copy(
        bitmap,
        start + Math.max(0, offset) * 4,
        start + Math.max(0, -offset) * 4,
        start + (22 - Math.max(0, offset)) * 4,
      );
    }
    const frame = Electron.nativeImage.createFromBitmap(bitmap, { width: 22, height: 22 });
    frame.setTemplateImage(platform === "darwin");
    return frame;
  });
  const animate = () => {
    animation?.abort();
    if (platform !== "darwin" && platform !== "win32") return;
    if (Electron.systemPreferences.getAnimationSettings().prefersReducedMotion) return;
    const controller = new AbortController();
    animation = controller;
    void runPromise(
      Effect.forEach(
        jiggleFrames,
        (frame) =>
          Effect.sync(() => {
            if (!tray.isDestroyed()) tray.setImage(frame);
          }).pipe(Effect.andThen(Effect.sleep("60 millis"))),
        { discard: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (animation === controller) {
              animation = null;
              if (!tray.isDestroyed()) tray.setImage(icon);
            }
          }),
        ),
      ),
      { signal: controller.signal },
    ).catch(() => undefined);
  };
  const update = () => {
    tray.setToolTip(
      state ? `mines · ${state.running} running · ${state.attention} need attention` : "mines",
    );
    if (platform === "darwin") tray.setTitle(menuBarTitle(state));
    if (platform === "linux") tray.setContextMenu(buildMenu());
    if (popup && !popup.isDestroyed()) popup.webContents.send(MENU_BAR_STATE_CHANNEL, state);
  };
  const togglePopup = Effect.fn("desktop.menuBar.togglePopup")(function* (focus = false) {
    if (disposed) return;
    if (popup) {
      closePopup();
      return;
    }
    if (opening) return;
    opening = true;
    try {
      const resource = yield* assets.resolveResourcePath("menu-bar/index.html");
      if (disposed) return;
      if (Option.isNone(resource)) {
        tray.popUpContextMenu(buildMenu());
        return;
      }
      const trayBounds = tray.getBounds();
      const workArea = Electron.screen.getDisplayMatching(trayBounds).workArea;
      const window = yield* electronWindow.create(
        {
          ...menuBarPanelBounds(trayBounds, workArea),
          ...(platform === "darwin" ? { type: "panel" } : {}),
          frame: false,
          transparent: true,
          backgroundColor: "#00000000",
          hasShadow: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          show: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          autoHideMenuBar: true,
          title: "mines",
          webPreferences: {
            preload: environment.path.join(environment.dirname, "menu-bar-preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
        "auxiliary",
      );
      popup = window;
      window.once("closed", () => {
        if (popup === window) popup = null;
      });
      window.on("blur", closePopup);
      window.webContents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "Escape") {
          event.preventDefault();
          closePopup();
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.once("ready-to-show", () => {
        if (!window.isDestroyed()) {
          if (focus) {
            window.show();
            window.focus();
          } else {
            window.showInactive();
          }
        }
      });
      yield* Effect.tryPromise(() => window.loadFile(resource.value)).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            if (disposed || window.isDestroyed() || tray.isDestroyed() || popup !== window) return;
            closePopup();
            tray.popUpContextMenu(buildMenu());
          }),
        ),
      );
    } finally {
      opening = false;
    }
  });
  if (platform !== "linux")
    tray.on("click", () => {
      void runPromise(togglePopup().pipe(Effect.ignore));
    });
  const showQuickView = () => {
    void runPromise(togglePopup(true).pipe(Effect.ignore));
  };
  const appEvents: NodeEvents.EventEmitter = Electron.app;
  appEvents.on(SHOW_MENU_BAR_EVENT, showQuickView);
  tray.on("right-click", () => tray.popUpContextMenu(buildMenu()));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      disposed = true;
      appEvents.removeListener(SHOW_MENU_BAR_EVENT, showQuickView);
      animation?.abort();
      animation = null;
      closePopup();
    }),
  );
  update();
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_MENU_BAR_STATE_CHANNEL,
      payload: DesktopMenuBarState,
      result: Schema.Void,
      handler: (next) =>
        Effect.sync(() => {
          const newActivity =
            next.running > (state?.running ?? 0) || next.attention > (state?.attention ?? 0);
          state = next;
          update();
          if (newActivity) animate();
        }),
    }),
  );
  const trustedPopup = (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) =>
    popup !== null && !popup.isDestroyed() && popup.webContents.id === event?.sender.id;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_MENU_BAR_STATE_CHANNEL,
      payload: Schema.Void,
      result: Schema.NullOr(DesktopMenuBarState),
      handler: (_input, event) =>
        trustedPopup(event) ? Effect.succeed(state) : Effect.fail(new MenuBarRequestRejected()),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: MENU_BAR_ACTION_CHANNEL,
      payload: Schema.String.check(Schema.isMaxLength(2_048)),
      result: Schema.Void,
      handler: Effect.fn("desktop.menuBar.action")(function* (action, event) {
        if (!trustedPopup(event) || !isMenuBarActionAllowed(action, state))
          return yield* new MenuBarRequestRejected();
        closePopup();
        if (action === "open") yield* desktopWindow.activate;
        else if (action === "new")
          yield* desktopWindow.dispatchMenuAction("new-thread", { reveal: true });
        else if (action === "accounts" || action === "devices")
          yield* desktopWindow.dispatchMenuAction(`mines:${action}`, { reveal: true });
        else if (action === "quit") Electron.app.quit();
        else if (action !== "close")
          yield* desktopWindow.dispatchMenuAction(action, { reveal: true });
      }),
    }),
  );
});
