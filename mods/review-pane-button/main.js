// The review pane's button, for a bar of your layout (28 px square, icon
// only): opens the review pane (mod review-pane) as a split to the right of
// the focused pane, for the repo that pane is in; closes it if the shown tab
// already has one. Lit while it's open. Key: `review-pane-button.toggle`.

import { View, div, svg } from "gpui-kit";
import { focused, nextCommand, panes, run, spaces, theme } from "herdr";

const PANE = "review-pane";
const ICON = "mods/review-pane/icons/branch.svg";

const shownTab = () => focused()?.tab ?? spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;
const openPane = () => {
  const tab = shownTab();
  return tab ? panes().find((p) => p.mod === PANE && p.tab === tab) ?? null : null;
};

// The repo to show: the focused terminal's folder, on its machine.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: on ?? null, space: space?.id ?? null };
}

function toggle() {
  const open = openPane();
  if (open) return run("pane.close", { pane: open.pane });
  const tab = shownTab();
  if (!tab) return;
  // Beside the focused pane; with a layout block focused (no pane), the tab's focused one.
  const f = focused(), mine = panes().filter((p) => p.tab === tab);
  const from = mine.find((p) => p.pane === f?.pane) ?? mine.find((p) => p.focused) ?? mine[0];
  run("pane.split", { direction: "right", ...(from ? { pane: from.pane } : {}), mod: PANE, props: location() });
}

export default class ReviewPaneButton extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "toggle") toggle();
        cx.notify();
      }
    });
  }

  render() {
    const t = theme(), on = Boolean(openPane());
    return div().id("review-pane-button").size(28).flex_none().flex().items_center().justify_center().rounded(6)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Review pane")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => toggle())
      .child(svg(ICON).size(15));
  }
}
