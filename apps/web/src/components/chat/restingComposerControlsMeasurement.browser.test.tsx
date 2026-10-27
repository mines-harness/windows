import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { resolveRestingComposerControlsLayout } from "../composerFooterLayout";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";

function Controls({ width }: { width: number }) {
  return (
    <div data-testid="controls" style={{ display: "flex", gap: 4, width }}>
      <button data-chat-provider-model-picker style={{ width: 140, minWidth: 80, flexShrink: 0 }}>
        Model
      </button>
      <button data-composer-fixed-control style={{ width: 80, flexShrink: 0 }}>
        Local
      </button>
      <div data-resting-block style={{ display: "flex", width: 100, flexShrink: 0 }}>
        <button style={{ display: "flex", gap: 4 }}>
          <span style={{ width: 36 }}>Icon</span>
          <span data-composer-control-label style={{ width: 60 }}>
            Build
          </span>
        </button>
      </div>
      <button data-resting-controls-overflow style={{ position: "absolute", width: 24 }}>
        More
      </button>
    </div>
  );
}

it("reserves the execution device before compacting controls after the first prompt", async () => {
  await using screen = await render(<Controls width={420} />);
  const controls = screen.container.querySelector<HTMLElement>('[data-testid="controls"]')!;
  const expanded = resolveRestingComposerControlsLayout({
    ...measureRestingComposerControls(controls)!,
    hostWidth: 420,
  });
  expect(expanded).toEqual({ hiddenCount: 0, iconOnlyCount: 0, visible: true });

  for (const width of [280, 420, 280]) {
    await screen.rerender(<Controls width={width} />);
    const layout = resolveRestingComposerControlsLayout({
      ...measureRestingComposerControls(controls)!,
      hostWidth: width,
      previous: expanded,
    });
    expect(layout).toEqual({
      hiddenCount: 0,
      iconOnlyCount: width === 280 ? 1 : 0,
      visible: true,
    });
  }
});
