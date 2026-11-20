// Drawing threads (a PR's pending review comments and GitHub's own review
// threads) and the comment box inside the review pane's list. Every item
// has a height known before it's drawn (the list is virtual), so each piece
// here has a fixed size and text is wrapped by count (monospace):
// threadHeight() and the views must agree.

import { div } from "gpui-kit";
import { h_flex, v_flex, Textarea } from "gpui-base";
import { lineLabel, wrapRows } from "./review.js";

export const LH = 17;          // a line of comment text
const OUTER = 8;               // space above and below a card
const PAD = 8;                 // inside a card, top and bottom
const HEAD_H = 24;             // a card's title row
const WHO_H = 18;              // a message's author
const GAP_H = 6;               // between messages
export const COMPOSER = 130;   // the comment box
const BOX_H = 70;              // its text area
const LEFT = 46;               // cards start after the line numbers (GUTTER)
export const SIDE_PAD = LEFT + 12 + 2 + 24 + 2; // a card's width the text doesn't get
const FOLDED_H = 28;           // a resolved GitHub thread, folded

// Resolved GitHub threads fold to one line, like GitHub's, until opened.
const folded = (view, n) => Boolean(n.gh && n.resolved) && !view.openResolved.has(n.id);

export function threadHeight(view, n, cols) {
  if (folded(view, n)) return OUTER + 2 + FOLDED_H;
  let h = OUTER + 2 + PAD * 2 + HEAD_H;
  for (const m of n.thread ?? []) h += GAP_H + WHO_H + wrapRows(m.text, cols) * LH;
  return h;
}

const KIND = { comment: "Pending review comment", github: "GitHub" };

function badge(t, text, color) {
  return div().flex_none().px(6).h(18).flex().items_center().rounded(5).border_1().border_color(t.border).text_size(10.5).text_color(color ?? t.muted).child(text);
}

// The frame every inline item sits in: inside the file's side borders, the
// card indented past the line numbers.
const frame = (t, h, id) => h_flex().id(id).h(h).flex_none().w_full().border_x_1().border_color(t.border).pl(LEFT).pr(12).py(OUTER / 2);

export function threadView(view, item, t) {
  const n = item.thread, h = threadHeight(view, n, view.textCols());
  const btn = (id, label, act) => view.button(t, `${id}-${n.id}`, label, act);
  const card = v_flex().id(`card-${n.id}`).size_full().rounded(8).border_1().border_color(n.kind === "comment" ? t.accent : t.border)
    .bg(t.surface ?? t.raised).overflow_hidden();
  if (folded(view, n)) {
    const first = n.thread?.[0];
    return frame(t, h, `thread-${n.id}`).child(card.child(
      h_flex().id(`open-${n.id}`).h(FOLDED_H).px(12).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { view.openResolved.add(n.id); cx.notify(); })
        .child(div().flex_none().text_size(11).text_color(t.ansi2).child("✓ Resolved"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`${lineLabel(n)} · ${first ? `${first.who}: ${first.text}` : ""}`)),
    ));
  }
  const busy = view.ghBusy === n.id;
  const head = h_flex().h(HEAD_H).flex_none().gap(6).items_center()
    .child(badge(t, KIND[n.kind] ?? "Note", n.kind === "comment" ? t.accent : null))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(lineLabel(n)))
    .when(item.outdated || Boolean(n.outdated), (e) => e.child(badge(t, "outdated", t.blocked)))
    .when(Boolean(n.resolved), (e) => e.child(badge(t, "resolved", t.ansi2)))
    .child(div().flex_1())
    .when(busy, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("…")))
    .when(Boolean(n.gh) && !busy, (e) => e
      .when(Boolean(n.resolved), (e) => e.child(btn("hide", "Hide", (cx) => { view.openResolved.delete(n.id); cx.notify(); })))
      .child(btn("reply", "Reply", (cx) => view.startReply(n, cx)))
      .child(btn("resolve", n.resolved ? "Unresolve" : "Resolve", (cx) => view.resolveGh(n, cx))))
    .when(!n.gh, (e) => e.child(btn("delete", "Delete", (cx) => view.deleteThread(n, cx))));
  const parts = [head];
  for (const m of n.thread ?? []) {
    const you = m.who === "you";
    parts.push(div().h(GAP_H).flex_none(),
      div().h(WHO_H).flex_none().text_size(11).font_semibold().text_color(you ? t.accent : t.ansi2).child(you ? "You" : m.who),
      ...String(m.text).split("\n").map((line) => div().w_full().flex_none().line_height(`${LH}px`).text_size(12).child(line.length ? line : " ")));
  }
  return frame(t, h, `thread-${n.id}`).child(card.child(v_flex().size_full().px(12).py(PAD).children(parts)));
}

// The comment box: under the selected lines, or under the GitHub thread it
// answers. "Send to agent" types it into the agent's terminal; in a PR,
// "Add review comment" keeps it for the review, and under a GitHub thread
// "Reply on GitHub" posts it there at once.
export function composerView(view, item, t) {
  const dr = view.draft, reply = dr?.replyTo ? view.threadById(dr.replyTo) : null;
  const comments = Boolean(view.pr) && !reply, github = Boolean(reply?.gh);
  const agent = view.agent();
  const act = (id, label, kind, primary) => h_flex().id(`draft-${id}`).h(26).px(10).flex_none().items_center().rounded(6).text_size(12)
    .cursor_pointer().bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
    .hover((s) => s.opacity(0.85))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => view.submitDraft(kind, cx)).child(label);
  return frame(t, COMPOSER, "composer").child(
    v_flex().size_full().p(8).gap(8).rounded(8).border_1().border_color(t.accent).bg(t.surface ?? t.raised)
      .child(div().id("composer-box").h(BOX_H).flex_none().w_full().px(8).py(6).rounded(6).border_1().border_color(t.border).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(view.draftInput).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().h(26).flex_none().gap(6).items_center()
        .when(github, (e) => e.child(act("reply", view.ghBusy === reply?.id ? "Posting…" : "Reply on GitHub", "reply", true)))
        .child(act("agent", "Send to agent", "agent", !comments && !github))
        .when(comments, (e) => e.child(act("comment", "Add review comment", "comment", true)))
        .child(view.button(t, "draft-cancel", "Cancel", (cx) => view.cancelDraft(cx)))
        .child(div().flex_1())
        .child(view.button(t, "draft-agent", agent ? `→ ${view.agentLabel(agent)}` : "No agent in this space", (cx) => view.nextAgent(cx), { tip: "Who gets it (click for the next agent)" }))),
  );
}
