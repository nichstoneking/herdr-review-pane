// Comments on diff lines for the review pane: what's sent to an agent in
// the space (typed into its terminal; the answer stays there), and a PR's
// pending review comments, kept in the shared value "review-pane.comments"
// ({"<machine or ''>:<repo root>": [comment]}) until the review is submitted.
//
// A pending comment is {id, file, section, cached, start, end, text,
// snippet, side, line, startSide, startLine, kind: "comment", thread}:
// side/line and startSide/startLine are the diff side ("old" or "new") and
// line numbers of the last and first selected rows; thread is [{who: "you",
// text, at}].

import { agents, panes, setShared, shared } from "herdr";

const STORE = "review-pane.comments";

export const notesKey = (on, root) => `${on ?? ""}:${root}`;

export function notesOf(key) {
  return (shared(STORE) ?? {})[key] ?? [];
}

function setNotes(key, list) {
  const all = { ...(shared(STORE) ?? {}) };
  if (list.length) all[key] = list;
  else delete all[key];
  setShared(STORE, all);
}

export function addThread(key, note) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  setNotes(key, [...notesOf(key), { ...note, id }]);
  return id;
}

export function removeThreads(key, ids) {
  setNotes(key, notesOf(key).filter((n) => !ids.includes(n.id)));
}

// ---- rows ---------------------------------------------------------------------

const sideOf = (r) => (r.k === "del" ? "old" : "new");
const lineOn = (r, side) => (side === "old" ? r.o : r.n);

// The selection rows a..b of a file's diff as a thread's anchor, or null
// (only folds selected).
export function rangeOf(rows, a, b) {
  const real = rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => r.k !== "fold");
  if (!real.length) return null;
  const first = real[0], last = real[real.length - 1];
  const nums = real.map((r) => r.n ?? r.o).filter((n) => n > 0);
  return {
    side: sideOf(last), line: lineOn(last, sideOf(last)),
    startSide: sideOf(first), startLine: lineOn(first, sideOf(first)),
    start: Math.min(...nums), end: Math.max(...nums),
    snippet: real.map((r) => r.m ?? "").join("\n") + "\n",
  };
}

// Where a thread sits in the rows now: {at: the row it hangs under, or -1,
// outdated}. Its line with the same text first; else the snippet found
// elsewhere (the code moved); else the line alone, outdated (the code
// changed); else nowhere (outdated, shown above the file's lines).
export function anchorOf(n, rows) {
  const side = n.side ?? null;
  const line = n.line ?? n.end;
  const at = (r) => (side ? lineOn(r, side) : r.n ?? r.o);
  const lines = (n.snippet ?? "").split("\n").filter((s) => s.length);
  const last = lines[lines.length - 1];
  if (line == null) return { at: -1, outdated: true };
  const byLine = rows.findIndex((r) => r.k !== "fold" && at(r) === line);
  if (byLine >= 0 && (!last || rows[byLine].m === last)) return { at: byLine, outdated: false };
  if (lines.length) {
    let best = -1;
    for (let i = lines.length - 1; i < rows.length; i++) {
      if (lines.every((s, k) => rows[i - (lines.length - 1) + k]?.m === s) && (best < 0 || Math.abs(at(rows[i]) - line) < Math.abs(at(rows[best]) - line))) best = i;
    }
    if (best >= 0) return { at: best, outdated: false };
  }
  return { at: byLine, outdated: true };
}

export const lineLabel = (n) => {
  const a = n.startLine ?? n.start, b = n.line ?? n.end;
  if (a == null && b == null) return "file";
  return a != null && b != null && a !== b ? `lines ${a}–${b}` : `line ${b ?? a}`;
};

// Rows of text `text` takes at `cols` columns (monospace, wrapped at spaces).
export function wrapRows(text, cols) {
  cols = Math.max(8, cols);
  let rows = 0;
  for (const line of String(text).split("\n")) {
    let n = 1, col = 0;
    for (const word of line.split(" ")) {
      const need = col === 0 ? word.length : col + 1 + word.length;
      if (need <= cols) { col = need; continue; }
      if (col > 0) { n++; col = 0; }
      n += Math.max(0, Math.ceil(word.length / cols) - 1);
      col = word.length % cols || Math.min(word.length, cols);
    }
    rows += n;
  }
  return rows;
}

// ---- agents -------------------------------------------------------------------

// Who to ask, best first: the agents in the pane's space working in the
// repo, then the space's others.
export function agentsFor(space, root) {
  const cwd = new Map(panes().map((p) => [p.pane, p.cwd ?? ""]));
  const inRoot = (a) => Boolean(root) && (cwd.get(a.pane) ?? "").startsWith(root);
  const here = agents().filter((a) => a.space === space);
  return [...here.filter(inRoot), ...here.filter((a) => !inRoot(a))];
}

export const agentName = (a) => `${a.program?.name ?? a.app ?? "agent"} · ${a.address}`;

// What the agent gets: where, the lines, the GitHub conversation it's
// about (if any), the message, and what it may do. Locally the agent works
// out from the message whether it's a question or a change; in a PR it
// only answers.
export function agentMessage({ file, root, pr, text, context = [], ...anchor }) {
  const where = `${file}, ${lineLabel(anchor)}${anchor.side === "old" ? " (old side: deleted lines)" : ""}`;
  const lines = [`[Review pane] ${where} in ${root}${pr ? ` (PR #${pr.number} under review)` : ""}:`, ""];
  if (anchor.snippet) lines.push("```diff", anchor.snippet.replace(/\n$/, ""), "```", "");
  if (context.length) {
    lines.push("About this GitHub review thread:");
    for (const m of context) lines.push(...`${m.who}: ${m.text}`.split("\n").map((s) => `> ${s}`));
    lines.push("");
  }
  lines.push(text, "");
  lines.push(pr
    ? "This is someone else's pull request: answer only. Never edit files, commit or push."
    : "If that asks for a change, make it in the working tree (don't commit); if it's a question, just answer.");
  return lines.join("\n");
}
