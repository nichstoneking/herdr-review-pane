// The review pane: every changed file of a repo stacked in one scrolling
// view, each collapsible, unified or split, like Zed's `git: diff` and
// `git: diff branch`. It opens as a split beside the focused pane
// (its button, review-pane-button, runs `pane.split {direction: "right", mod: "review-pane", props: {cwd, on, space}}`).
//
// Scopes: Uncommitted (staged and unstaged, as separate entries; stage,
// unstage, discard and commit work here) and Base (the working tree against
// the merge-base with a branch: the engine's default base, or one picked).
// The diffs come from plain git (engine.js); nothing here has keys.
//
// Review: click or drag line numbers to write about those lines, like
// GitHub. "Send to agent" types the message, with the lines, into an agent
// of the space; it answers or changes the code there (review.js). "PRs"
// checks a pull request out in a worktree with a reviewer agent in a new tab
// of the space; there the pane is in PR mode (props.pr, or the worktree's
// herdr-review/pr.json): GitHub's comments show as threads, "Add review
// comment" keeps a pending one, and Review submits them (github.js).
// Agents never commit there.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popup, Textarea, TextareaState } from "gpui-base";
import { knownAgents, nextCommand, notify, panes, props, run, settings, spaces, theme, watchFolder } from "herdr";
import { act, commit, diff, editor, git, message, send, status } from "./engine.js";
import { Scroller } from "./scroller.js";
import { unzoom } from "./zoom.js";
import { color, isDark, readable } from "./paint.js";
import { addThread, agentMessage, agentName, agentsFor, anchorOf, notesKey, notesOf, rangeOf, removeThreads } from "./review.js";
import { checkoutPR, listPRs, prThreads, readPR, replyToThread, setResolved, submitReview, viewPR, viewerLogin } from "./github.js";
import { COMPOSER, SIDE_PAD, composerView, threadHeight, threadView } from "./threads.js";

const ROW = 18;      // a diff line
const HEAD = 36;     // a file's header
const GAP = 5;       // between files, and above the first
const END = 6;       // an open file's closing edge
const MSG = 28;      // "Loading…" and other one-liners
const GUTTER = 46;   // a line-number column
const COL = 7.2;     // one monospace column at 12 px, for the sideways range
const LOADS = 4;     // diffs loading at once
const ICONS = "mods/review-pane/icons";

const icon = (name, size, c) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(c);
const nbsp = (s) => s.replace(/ /g, " ");

// The engine's code spans of a row, without its marker (▌) and number.
const codeSpans = (row) => (row.s ?? []).filter(([text, fg]) => fg !== "@gutter" && text !== "▌");
const cols = (row) => codeSpans(row).reduce((n, [text]) => n + text.length, 0);

// Split view: context on both sides, a run of deletions beside the run of
// additions that follows it, anything else (folds) across both.
function pairs(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.k === "del" || r.k === "add") {
      const dels = [], adds = [];
      while (i < rows.length && rows[i].k === "del") dels.push(rows[i++]);
      while (i < rows.length && rows[i].k === "add") adds.push(rows[i++]);
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) out.push({ l: dels[j] ?? null, r: adds[j] ?? null });
    } else {
      out.push(r.k === "ctx" ? { l: r, r } : { across: r });
      i++;
    }
  }
  return out;
}

export default class ChangesTab extends View {
  init(initial, cx) {
    const p = props() ?? initial ?? {};
    this.cwd = p.cwd ?? null;
    this.on = p.on ?? null;
    this.space = p.space ?? spaces().find((s) => s.active)?.id ?? null;
    this.pr = p.pr ?? null;   // {number, title, url, author, base, headRef, head, repo} in PR mode
    this.scope = this.pr ? "branch" : "worktree";
    this.pickedBase = this.pr ? `origin/${this.pr.base}` : null; // a branch the person picked, or null: the engine's
    this.split = false;
    this.status = null;
    this.files = [];
    this.allOpen = false;     // files start collapsed; "expand all" flips the default
    this.flipped = new Set(); // keys toggled away from the default
    this.diffs = new Map();   // key -> {rev, rows, loading, error, unfold, ...}
    this.loadingCount = 0;
    this.error = null;
    this.loading = false;
    this.again = false;
    this.ver = 0;
    this.built = null;
    this.confirming = null;   // {key, until}: Discard asks for a second click
    this.picker = null;       // the base picker: {branches, error} while open
    this.busy = null;         // "commit", or an op on a file key
    this.scroll = new Scroller("changes-rows", { horizontal: true });
    this.commitInput = TextareaState.new({ placeholder: "Commit message", rows: 1 });
    this.commitInput.set_auto_grow(1, 6);
    this.commitInput.on("change", (_e, cx) => cx.notify());
    this.commitInput.on("submit", (_e, cx) => this.commit(cx));
    // Review: the selection being dragged ({fileKey, a, b}: row indices), the
    // comment box ({fileKey, a, b} or {replyTo}), GitHub's threads in PR mode.
    this.sel = null;
    this.dragging = false;
    this.draft = null;
    this.draftInput = TextareaState.new({ placeholder: "Leave a comment", rows: 3 });
    this.draftInput.on("change", (_e, cx) => cx.notify());
    this.draftInput.on("submit", (_e, cx) => this.submitDraft(this.draft?.replyTo ? (this.threadById(this.draft.replyTo)?.gh ? "reply" : "agent") : this.pr ? "comment" : "agent", cx));
    this.ghThreads = [];
    this.ghAt = 0;
    this.ghVer = 0;
    this.agentPick = null;    // the agent messages go to, or null: the best one
    this.openResolved = new Set(); // resolved GitHub threads shown open
    this.ghBusy = null;       // a GitHub thread being replied to or (un)resolved
    this.gitdirs = new Map(); // root -> its git dir
    this.prChecked = new Set();
    this.prList = null;       // the PR picker: {prs, error, busy} while open
    this.review = null;       // the Review box: {error, busy} while open
    this.reviewInput = TextareaState.new({ placeholder: "Review summary (optional)", rows: 3 });
    this.over = {};           // which popup trigger the pointer is on
    this.refresh(cx);
    cx.timer.every(this.on ? 5000 : 4000, (cx) => this.refresh(cx));
    // What the buttons do, as commands (`review-pane.<command>`), for keys.json or scripts:
    // scope:worktree|branch, base:<branch>|default, pick-base, view:split|unified, collapse, expand, toggle-all, refresh;
    // select:<path>:<row>:<row> (rows of the file's diff), draft:<text>, send:agent|comment|reply,
    // reply:<GitHub thread id> (the box under it), resolve:<GitHub thread id> (or unresolve), delete:<thread id>,
    // prs, pr:<number>, review (the box), review:COMMENT|APPROVE|REQUEST_CHANGES[:<summary>].
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const [what, ...rest] = c.split(":");
        const arg = rest.join(":");
        if (what === "scope") this.setScope(arg === "branch" ? "branch" : "worktree", cx);
        else if (what === "base") this.setBase(arg && arg !== "default" ? arg : null, cx);
        else if (what === "pick-base") { this.setScope("branch", cx); this.openPicker(cx); }
        else if (what === "view") { this.split = arg === "split"; this.built = null; }
        else if (what === "collapse" || what === "expand") this.setAll(what === "collapse", cx);
        else if (what === "toggle-all") this.setAll(this.anyOpen(), cx);
        else if (what === "refresh") this.refresh(cx);
        else if (what === "select") this.selectRows(rest[0], Number(rest[1]), Number(rest[2] ?? rest[1]), cx);
        else if (what === "draft") this.draftInput.set_value(arg);
        else if (what === "send") this.submitDraft(arg || "agent", cx);
        else if (what === "reply") { const n = this.threadById(arg); if (n) this.startReply(n, cx); }
        else if (what === "delete") { const n = this.threadById(arg); if (n) this.deleteThread(n, cx); }
        else if (what === "resolve") { const n = this.threadById(arg); if (n?.gh) this.resolveGh(n, cx); }
        else if (what === "prs") this.openPRs(cx);
        else if (what === "pr") this.startPR(Number(arg), cx);
        else if (what === "review" && !rest[0]) this.review = this.review ? null : { busy: null, error: null };
        else if (what === "review") this.submitReview(rest[0], cx, rest.slice(1).join(":") || null);
        cx.notify();
      }
    });
  }

  // ---- data -------------------------------------------------------------------

  where() {
    return { cwd: this.status?.root ?? this.cwd, on: this.on };
  }

  refresh(cx) {
    if (!this.cwd) { this.error = "No folder for this pane"; return; }
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    const scope = this.scope, picked = this.pickedBase;
    cx.spawn(async (cx) => {
      try {
        const st = await status({ cwd: this.cwd, on: this.on }, scope, scope === "branch" ? picked : null);
        if (scope !== this.scope || picked !== this.pickedBase) return; // switched meanwhile
        const files = st.sections.flatMap((s) => s.files.map((f) => ({ ...f, section: s.id, cached: s.cached, key: `${s.id}:${f.path}` })));
        const keys = new Set(files.map((f) => f.key));
        for (const [k, d] of this.diffs) {
          if (!keys.has(k)) this.diffs.delete(k);
        }
        for (const f of files) {
          const d = this.diffs.get(f.key);
          if (d && d.rev !== f.rev) d.stale = true;
        }
        this.status = st;
        this.files = files;
        this.error = null;
        this.watch(st.root, cx);
        this.afterStatus(st.root, cx);
      } catch (e) {
        this.error = message(e);
      } finally {
        this.loading = false;
        this.ver++;
        cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  // Refresh on changes in the repo (this computer only; remote repos poll).
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const batch = await watchFolder(root);
          // git's own bookkeeping (locks, logs, objects) isn't a change.
          const real = batch.some((p) => !p.includes("/.git/") || /\/\.git\/(index|HEAD|refs\/)/.test(p));
          if (!real) continue;
          await cx.sleep(300);
          this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  // Load (or reload, when stale) the diffs of the files near the view.
  loadNear(cx) {
    const want = [];
    const b = this.built;
    if (!b) return;
    const top = this.scroll.top - 1500, bottom = this.scroll.top + (this.scroll.height || 900) + 1500;
    for (const [i, item] of b.items.entries()) {
      if (!item.head) continue;
      const y = this.scroll.offsets[i] ?? 0;
      if (y > bottom) break;
      if (y + (b.heights[item.key] ?? 0) < top) continue;
      const d = this.diffs.get(item.f.key);
      if (this.isCollapsed(item.f.key)) continue;
      if (!d || (d.stale && !d.loading)) want.push(item.f);
    }
    for (const f of want) {
      if (this.loadingCount >= LOADS) break;
      this.load(f, cx);
    }
  }

  load(f, cx) {
    const prev = this.diffs.get(f.key);
    if (prev?.loading) return;
    const d = { ...(prev ?? {}), rev: f.rev, loading: true, stale: false };
    this.diffs.set(f.key, d);
    this.loadingCount++;
    const scope = this.scope, base = this.status?.base?.merge_base;
    cx.spawn(async (cx) => {
      try {
        const r = await diff(this.where(), f, { cached: f.cached, mergeBase: scope === "branch" ? base : null, unfold: d.unfold, dark: isDark(theme().background) });
        if (scope !== this.scope || base !== this.status?.base?.merge_base) return;
        Object.assign(d, { rows: r.rows ?? [], truncated: r.truncated, binary: r.binary, empty: r.empty, first: r.first_change, error: null });
        d.index = new Map(d.rows.map((row, i) => [row, i]));
      } catch (e) {
        d.error = message(e).split("\n")[0]; // one line: it's drawn in a one-line row
      } finally {
        d.loading = false;
        this.loadingCount--;
        this.ver++;
        cx.notify();
      }
    });
  }

  // ---- actions ----------------------------------------------------------------

  setScope(scope, cx) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.reset(cx);
  }

  setBase(label, cx) {
    this.picker = null;
    this.pickedBase = label;
    this.scope = "branch";
    this.reset(cx);
  }

  reset(cx) {
    this.diffs.clear();
    this.files = [];
    this.status = null;
    this.scroll.top = 0;
    this.ver++;
    this.again = this.loading; // a status on its way is for the old scope
    this.refresh(cx);
    cx.notify();
  }

  openPicker(cx) {
    if (this.picker) { this.picker = null; return cx.notify(); }
    this.picker = { branches: null, error: null };
    cx.spawn(async (cx) => {
      try {
        const out = await git(["for-each-ref", "--sort=-committerdate", "--count=200", "--format=%(refname:short)", "refs/heads", "refs/remotes"], this.where());
        if (this.picker) this.picker.branches = out.split("\n").filter((b) => b && !b.endsWith("/HEAD"));
      } catch (e) {
        if (this.picker) this.picker.error = message(e);
      } finally { cx.notify(); }
    });
    cx.notify();
  }

  act(op, f, cx) {
    const st = this.status;
    if (!st || this.busy) return;
    if (op === "discard") {
      const c = this.confirming;
      if (!c || c.key !== f.key || Date.now() > c.until) {
        this.confirming = { key: f.key, until: Date.now() + 4000 };
        cx.spawn(async (cx) => { await cx.sleep(4100); cx.notify(); });
        return cx.notify();
      }
      this.confirming = null;
    }
    this.busy = f.key;
    cx.spawn(async (cx) => {
      try {
        await act(op, f, f.section, { cwd: st.root, on: this.on });
      } catch (e) {
        notify({ title: `Couldn't ${op} ${f.path}`, body: message(e), level: "error" });
      } finally {
        this.busy = null;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  commit(cx) {
    const text = this.commitInput.value().trim();
    const st = this.status;
    if (!text || !st || this.busy || this.scope !== "worktree") return;
    this.busy = "commit";
    cx.spawn(async (cx) => {
      try {
        const summary = await commit(text, { cwd: st.root, on: this.on });
        this.commitInput.set_value("");
        notify({ title: "Committed", body: summary || text, level: "success" });
      } catch (e) {
        notify({ title: "Commit failed", body: message(e), level: "error" });
      } finally {
        this.busy = null;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  // The repo's editor in a pane to the right, at the file's first change.
  openFile(f) {
    const st = this.status;
    if (!st) return;
    const line = this.diffs.get(f.key)?.first ?? 1;
    (async () => {
      try {
        const ed = await editor({ cwd: st.root, on: this.on });
        const argv = ed?.argv ?? ["vi"];
        const atLine = ["nvim", "vim", "vi", "hx", "nano", "emacs"].includes(ed?.kind ?? "vi") ? [`+${line}`] : [];
        run("terminal.open", { argv: [...argv, ...atLine, f.path], folder: st.root, place: "right" });
      } catch (e) {
        notify({ title: "Couldn't open the file", body: message(e), level: "error" });
      }
    })();
  }

  // ---- review -----------------------------------------------------------------

  notesKey() {
    const root = this.status?.root;
    return root ? notesKey(this.on, root) : null;
  }

  threadById(id) {
    const key = this.notesKey();
    return (key ? notesOf(key) : []).find((n) => n.id === id) ?? this.ghThreads.find((n) => n.id === id) ?? null;
  }

  // Comment text gets a card's width less its frame, in monospace columns.
  textCols() {
    return Math.max(20, Math.floor(((this.scroll.vw || 800) - SIDE_PAD) / COL));
  }

  async gitdir(root) {
    if (!this.gitdirs.has(root)) this.gitdirs.set(root, (await git(["rev-parse", "--absolute-git-dir"], { cwd: root, on: this.on })).trim());
    return this.gitdirs.get(root);
  }

  // After a status: a PR's worktree (its pr.json) turns PR mode on; in PR
  // mode, GitHub's threads, every 30 s at most.
  afterStatus(root, cx) {
    cx.spawn(async (cx) => {
      try {
        if (!this.pr && !this.prChecked.has(root)) {
          this.prChecked.add(root);
          const pr = await readPR(await this.gitdir(root), this.on);
          if (pr) {
            this.pr = pr;
            this.setBase(`origin/${pr.base}`, cx);
            return;
          }
        }
        if (this.pr && Date.now() - this.ghAt > 30000) {
          await this.loadGh();
          cx.notify();
        }
      } catch (e) {
        if (this.pr) { this.ghError = message(e); cx.notify(); }
      }
    });
  }

  agents() {
    return agentsFor(this.space, this.status?.root ?? this.cwd);
  }

  agent() {
    const list = this.agents();
    return list.find((a) => a.address === this.agentPick) ?? list[0] ?? null;
  }

  agentLabel(a) {
    return agentName(a);
  }

  nextAgent(cx) {
    const list = this.agents();
    if (!list.length) return;
    const i = list.findIndex((a) => a.address === this.agent()?.address);
    this.agentPick = list[(i + 1) % list.length].address;
    cx.notify();
  }

  // Selecting lines: press a line number, drag over others, let go (or
  // shift-press to stretch the open comment's lines); the comment box opens
  // under the last one.
  inSelection(f, ri) {
    const s = this.sel ?? (this.draft && !this.draft.replyTo ? this.draft : null);
    return Boolean(s) && ri >= 0 && s.fileKey === f.key && ri >= Math.min(s.a, s.b) && ri <= Math.max(s.a, s.b);
  }

  pressLine(f, ri, shift, cx) {
    const dr = this.draft;
    this.sel = shift && dr && !dr.replyTo && dr.fileKey === f.key ? { fileKey: f.key, a: dr.a, b: ri } : { fileKey: f.key, a: ri, b: ri };
    this.dragging = true;
    cx.notify();
  }

  dragOver(f, ri, cx) {
    if (!this.dragging || ri < 0 || this.sel?.fileKey !== f.key || this.sel.b === ri) return;
    this.sel.b = ri;
    cx.notify();
  }

  release(cx) {
    if (!this.dragging) return;
    this.dragging = false;
    const s = this.sel;
    this.sel = null;
    if (s) this.openDraft({ fileKey: s.fileKey, a: Math.min(s.a, s.b), b: Math.max(s.a, s.b) }, cx);
  }

  selectRows(path, a, b, cx) {
    const f = this.files.find((x) => x.path === path);
    if (f) this.openDraft({ fileKey: f.key, a: Math.min(a, b), b: Math.max(a, b) }, cx);
  }

  openDraft(dr, cx) {
    if (dr.fileKey && !rangeOf(this.diffs.get(dr.fileKey)?.rows ?? [], dr.a, dr.b)) return;
    this.draft = dr;
    this.draftInput.set_value("");
    this.draftInput.focus();
    this.revealDraft = true;
    cx.notify();
  }

  startReply(n, cx) {
    this.openDraft({ replyTo: n.id }, cx);
  }

  cancelDraft(cx) {
    this.draft = null;
    this.draftInput.set_value("");
    cx.notify();
  }

  // The comment box's buttons: "agent" (typed into the agent's terminal;
  // nothing stays here), "comment" (a pending comment of the PR's review) or
  // "reply" (posted on the GitHub thread it's under, at once).
  submitDraft(kind, cx) {
    const dr = this.draft, key = this.notesKey(), root = this.status?.root, text = this.draftInput.value().trim();
    if (!dr || !key || !text || (kind === "comment" && !this.pr)) return;
    if (kind === "reply") return this.replyGh(this.threadById(dr.replyTo), text, cx);
    let anchor, context = [];
    if (dr.replyTo) {
      const n = this.threadById(dr.replyTo);
      if (!n) return this.cancelDraft(cx);
      const f = this.files.find((x) => x.path === n.file), rows = f && this.diffs.get(f.key)?.rows;
      const at = rows ? anchorOf(n, rows).at : -1;
      anchor = { file: n.file, side: n.side, line: n.line, startLine: n.startLine, startSide: n.startSide, snippet: at >= 0 ? `${rows[at].m}\n` : "" };
      context = n.thread;
    } else {
      const f = this.files.find((x) => x.key === dr.fileKey);
      const range = f && rangeOf(this.diffs.get(f.key)?.rows ?? [], dr.a, dr.b);
      if (!range) return;
      anchor = { file: f.path, section: f.section, cached: Boolean(f.cached), ...range };
    }
    if (kind === "comment") {
      addThread(key, { ...anchor, text, kind, thread: [{ who: "you", text, at: new Date().toISOString() }] });
    } else {
      const a = this.agent();
      if (!a) return notify({ title: "No agent in this space", body: "Start one, then send again.", level: "warning" });
      const msg = agentMessage({ ...anchor, root, pr: this.pr, text, context });
      cx.spawn(async () => {
        try {
          await send(a.address, msg);
          notify({ title: "Sent", body: agentName(a), level: "success" });
        } catch (e) {
          notify({ title: `Couldn't send to ${agentName(a)}`, body: message(e), level: "error" });
        }
      });
    }
    this.draft = null;
    this.draftInput.set_value("");
    cx.notify();
  }

  deleteThread(n, cx) {
    removeThreads(this.notesKey(), [n.id]);
    if (this.draft?.replyTo === n.id) this.draft = null;
    cx.notify();
  }

  // ---- GitHub threads -------------------------------------------------------------

  async loadGh() {
    this.ghAt = Date.now();
    this.ghThreads = await prThreads(this.pr, this.where());
    this.me = await viewerLogin(this.where()).catch(() => null);
    this.ghError = null;
    this.ghVer++;
  }

  // The box's text as a reply on the thread; the box stays (text kept) if it fails.
  replyGh(n, text, cx) {
    if (!n?.gh || this.ghBusy) return;
    this.ghBusy = n.id;
    cx.spawn(async (cx) => {
      try {
        await replyToThread(n.node, text, this.where());
        this.draft = null;
        this.draftInput.set_value("");
        await this.loadGh();
      } catch (e) {
        notify({ title: "Couldn't reply on GitHub", body: message(e), level: "error" });
      } finally {
        this.ghBusy = null;
        cx.notify();
      }
    });
    cx.notify();
  }

  // Resolves the thread (it folds) or opens it again.
  resolveGh(n, cx) {
    if (this.ghBusy) return;
    this.ghBusy = n.id;
    cx.spawn(async (cx) => {
      try {
        await setResolved(n.node, !n.resolved, this.where());
        this.openResolved.delete(n.id);
        await this.loadGh();
      } catch (e) {
        notify({ title: `Couldn't ${n.resolved ? "unresolve" : "resolve"} the thread`, body: message(e), level: "error" });
      } finally {
        this.ghBusy = null;
        cx.notify();
      }
    });
    cx.notify();
  }

  // ---- pull requests ------------------------------------------------------------

  openPRs(cx) {
    if (this.prList) { this.prList = null; return cx.notify(); }
    this.prList = { prs: null, error: null, busy: null };
    cx.spawn(async (cx) => {
      try {
        const prs = await listPRs(this.where());
        if (this.prList) this.prList.prs = prs;
      } catch (e) {
        if (this.prList) this.prList.error = message(e);
      }
      cx.notify();
    });
    cx.notify();
  }

  startPR(number, cx) {
    const st = this.status;
    if (!st || !number) return;
    if (!this.prList) this.prList = { prs: null, error: null, busy: null };
    this.prList.busy = number;
    this.prList.error = null;
    cx.spawn(async (cx) => {
      try {
        const pr = this.prList?.prs?.find((p) => p.number === number) ?? await viewPR(number, this.where());
        const { dir, info } = await checkoutPR(pr, { root: st.root, on: this.on });
        await this.openReviewTab(dir, info, cx);
        this.prList = null;
      } catch (e) {
        if (this.prList) Object.assign(this.prList, { busy: null, error: message(e) });
        else notify({ title: `Couldn't start reviewing #${number}`, body: message(e), level: "error" });
      }
      cx.notify();
    });
    cx.notify();
  }

  // The review's tab in this space: the reviewer agent left, a review pane
  // in PR mode right. Already open: go there.
  async openReviewTab(dir, info, cx) {
    const space = this.space ?? spaces().find((s) => s.active)?.id;
    const split = (pane) => run("pane.split", { pane, direction: "right", mod: "review-pane", props: { cwd: dir, on: this.on, space, pr: info } });
    const open = panes().find((p) => p.cwd === dir || p.cwd?.startsWith(`${dir}/`));
    if (open) {
      run("tab.select", { id: open.tab });
      if (!panes().some((p) => p.tab === open.tab && p.mod === "review-pane")) split(open.pane);
      return;
    }
    // The reviewer: the program of the space's agent if it's one you can start, else your most picked.
    const usual = this.agents()[0]?.program?.key;
    const known = (await knownAgents({ on: this.on }).catch(() => [])).filter((a) => a.installed);
    const agent = known.find((a) => a.key === usual) ?? known[0];
    const before = spaces().find((s) => s.id === space)?.tabs.find((t) => t.active)?.id;
    run("tab.new", { name: `PR #${info.number}`, space, folder: dir, ...(agent ? { argv: agent.run } : {}) });
    for (let i = 0; i < 40; i++) {
      await cx.sleep(150);
      const tab = spaces().find((s) => s.id === space)?.tabs.find((t) => t.active);
      const first = tab && tab.id !== before ? panes().find((p) => p.tab === tab.id) : null;
      if (first) return split(first.pane);
    }
    notify({ title: `PR #${info.number}`, body: `Checked out in ${dir}, but its tab didn't show up`, level: "warning" });
  }

  pending() {
    const key = this.notesKey();
    return key ? notesOf(key).filter((n) => n.kind === "comment") : [];
  }

  // Posts the review with the pending comments; `body` (from a command)
  // stands in for the Review box's summary.
  submitReview(event, cx, body = null) {
    if (!this.pr || this.review?.busy) return;
    const comments = this.pending();
    const text = body ?? this.reviewInput.value().trim();
    if (event === "COMMENT" && !comments.length && !text) {
      this.review = { busy: null, error: "Add a comment or a summary first" };
      return cx.notify();
    }
    this.review = { busy: event, error: null };
    cx.spawn(async (cx) => {
      try {
        await submitReview(this.pr, { event, body: text, comments }, this.where());
        removeThreads(this.notesKey(), comments.map((n) => n.id));
        this.reviewInput.set_value("");
        this.review = null;
        this.ghAt = 0;
        this.refresh(cx);
        const what = { COMMENT: "Commented", APPROVE: "Approved", REQUEST_CHANGES: "Requested changes" }[event] ?? event;
        notify({ title: `PR #${this.pr.number}`, body: `${what}${comments.length ? ` with ${comments.length} comment${comments.length === 1 ? "" : "s"}` : ""}`, level: "success" });
      } catch (e) {
        this.review = { busy: null, error: message(e) };
      }
      cx.notify();
    });
    cx.notify();
  }

  unfold(f, cx) {
    const d = this.diffs.get(f.key);
    if (!d || d.unfold) return;
    d.unfold = true;
    d.stale = true;
    this.load(f, cx);
  }

  isCollapsed(key) {
    return this.flipped.has(key) === this.allOpen;
  }

  anyOpen() {
    return this.files.some((f) => !this.isCollapsed(f.key));
  }

  toggle(f, cx) {
    if (this.flipped.has(f.key)) this.flipped.delete(f.key);
    else this.flipped.add(f.key);
    this.ver++;
    cx.notify();
  }

  setAll(collapsed, cx) {
    this.allOpen = !collapsed;
    this.flipped.clear();
    this.ver++;
    cx.notify();
  }

  // ---- layout -----------------------------------------------------------------

  // Which file each thread belongs to (its section's copy of the path, else
  // the first shown): fileKey -> [thread], GitHub's first (ours reply to them).
  threadsByFile(notes) {
    const out = new Map();
    for (const n of [...this.ghThreads, ...notes]) {
      const same = this.files.filter((f) => f.path === n.file);
      const f = same.find((x) => x.section === n.section) ?? same[0];
      if (f) out.set(f.key, [...(out.get(f.key) ?? []), n]);
    }
    return out;
  }

  // The flat list the scroller draws: a gap, then per file a header, its
  // lines with their threads (and the comment box) under them, a gap.
  build() {
    const notes = this.notesKey() ? notesOf(this.notesKey()) : [];
    const tcols = this.textCols();
    const dr = this.draft;
    const key = [this.ver, this.split, tcols, this.ghVer, JSON.stringify(notes), dr ? `${dr.fileKey}:${dr.a}:${dr.b}:${dr.replyTo}` : "", [...this.openResolved].join(",")].join("|");
    if (this.built?.key === key) return this.built;
    const items = [], sizes = [], heights = {};
    let maxCols = 0;
    const threads = this.threadsByFile(notes);
    if (this.files.length) { items.push({ gap: true }); sizes.push(GAP); }
    for (const f of this.files) {
      const start = sizes.length;
      const mine = threads.get(f.key) ?? [];
      items.push({ head: true, f, key: f.key, count: mine.length });
      sizes.push(HEAD);
      if (!this.isCollapsed(f.key)) {
        const d = this.diffs.get(f.key);
        const msg = (text) => { items.push({ msg: text, f }); sizes.push(MSG); };
        const composer = () => { items.push({ composer: true, f }); sizes.push(COMPOSER); };
        const thread = ({ n, outdated }) => {
          items.push({ thread: n, f, outdated });
          sizes.push(threadHeight(this, n, tcols));
          if (dr?.replyTo === n.id) composer();
        };
        if (!d?.rows) msg(d?.error ? `Couldn't load: ${d.error}` : "Loading…");
        else if (d.binary) msg("Binary file");
        else if (!d.rows.length) msg(d.empty ? "Empty file" : "No line changes (mode or permissions only)");
        else {
          for (const r of d.rows) maxCols = Math.max(maxCols, cols(r));
          // Threads hang under their row; ones whose code is gone go first.
          const under = new Map();
          for (const n of mine) {
            const a = anchorOf(n, d.rows);
            if (a.at < 0) thread({ n, outdated: true });
            else under.set(a.at, [...(under.get(a.at) ?? []), { n, outdated: a.outdated }]);
          }
          const draftAt = dr && !dr.replyTo && dr.fileKey === f.key ? dr.b : -1;
          const lines = this.split ? pairs(d.rows) : d.rows;
          for (const line of lines) {
            items.push(this.split ? { pair: line, f } : { row: line, f, ri: d.index.get(line) });
            sizes.push(ROW);
            const covered = this.split ? [...new Set([line.l, line.r, line.across].filter(Boolean))] : [line];
            for (const ri of covered.map((r) => d.index.get(r)).sort((a, b) => a - b)) {
              for (const x of under.get(ri) ?? []) thread(x);
              if (ri === draftAt) composer();
            }
          }
          if (d.truncated) msg(`Diff cut at ${d.rows.length} lines`);
        }
        items.push({ end: true });
        sizes.push(END);
      }
      items.push({ gap: true });
      sizes.push(GAP);
      heights[f.key] = sizes.slice(start).reduce((a, b) => a + b, 0);
    }
    this.scroll.measure(sizes);
    const content = (maxCols + 4) * COL;
    this.scroll.setContent(this.split ? (content + GUTTER) * 2 : content + GUTTER);
    if (this.revealDraft) {
      this.revealDraft = false;
      const at = items.findIndex((x) => x.composer);
      if (at >= 0) this.scroll.reveal(at, { margin: 12 });
    }
    this.built = { key, items, heights };
    return this.built;
  }

  // ---- drawing ----------------------------------------------------------------

  render(cx) {
    const t = theme();
    const b = this.build();
    this.loadNear(cx);
    const font = settings().font_family ?? "JetBrains Mono";
    const st = this.status;
    let body;
    if (this.error && !st) body = this.note(t, this.error);
    else if (!st) body = this.note(t, "Loading…");
    else if (!this.files.length) body = this.note(t, this.scope === "worktree" ? "No uncommitted changes" : `No changes since ${st.base?.label ?? "the base"}`);
    else body = v_flex().flex_1().min_h(0).font_family(font).text_size(12).child(this.scroll.view(t, (i) => this.item(b.items[i], t, cx)));
    return v_flex()
      .id("review-pane")
      .on_size_change((size, cx) => {
        const width = unzoom(size.width);
        if (width !== this.width) { this.width = width; cx.notify(); }
      })
      .relative()
      .size_full()
      .min_h(0)
      .rounded(8)
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .child(this.topBar(t))
      .when(this.scope === "worktree" && Boolean(st) && this.files.length > 0, (e) => e.child(this.commitRow(t)))
      .child(body)
      .on_mouse_up("left", (_e, cx) => this.release(cx));
  }

  note(t, text) {
    return div().flex_1().p(16).text_color(t.dim).child(text);
  }

  button(t, id, label, onPress, { on = false, iconName = null, tip = null, danger = false } = {}) {
    return h_flex()
      .id(id)
      .h(26)
      .px(iconName && !label ? 0 : 9)
      .when(Boolean(iconName) && !label, (e) => e.w(26).justify_center())
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .text_size(12)
      .when(on || danger, (e) => e.bg(on ? t.selected : `${t.ansi1}33`))
      .text_color(on ? t.foreground : danger ? t.ansi1 : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onPress(cx); })
      .when(Boolean(iconName), (e) => e.child(svg(`${ICONS}/${iconName}.svg`).size(14).flex_none()))
      .when(Boolean(label), (e) => e.child(label));
  }

  topBar(t) {
    const st = this.status, pr = this.pr;
    const add = this.files.reduce((n, f) => n + (f.add ?? 0), 0);
    const del = this.files.reduce((n, f) => n + (f.del ?? 0), 0);
    const base = this.pickedBase ?? st?.base?.label ?? (this.scope === "branch" ? "…" : "default");
    const title = pr ? `PR #${pr.number}` : this.scope === "worktree" ? "Uncommitted changes" : `Changes since ${base}`;
    const repo = (st?.root ?? this.cwd ?? "").split("/").pop();
    const about = pr ? `${pr.title}${pr.author ? ` · @${pr.author}` : ""} · ${pr.base} ← ${pr.headRef}` : `${repo}${st?.branch ? ` · ${st.branch}` : ""}${this.on ? ` · ${this.on}` : ""}`;
    const anyOpen = this.anyOpen();
    // Narrower than the bar needs: the title on one row, the controls on a second,
    // the base branch's name cut to what's left.
    const width = this.width ?? 0, narrow = width > 0 && width < 760;
    const head = [
      icon("branch", 14, t.muted),
      div().min_w(0).truncate().font_semibold().child(title),
      div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(about),
    ];
    if (pr && this.ghError) head.push(div().id("gh-error").flex_none().text_size(11).text_color(t.blocked).tooltip(this.ghError).child("GitHub comments didn't load"));
    if (add > 0) head.push(div().flex_none().text_size(12).text_color(t.ansi2).child(`+${add.toLocaleString()}`));
    if (del > 0) head.push(div().flex_none().text_size(12).text_color(t.ansi1).child(`−${del.toLocaleString()}`));
    const controls = [
      pr ? this.reviewPopup(t) : h_flex().flex_none().gap(2).p(2).rounded(8).bg(t.chrome)
        .child(this.button(t, "scope-worktree", "Uncommitted", (cx) => this.setScope("worktree", cx), { on: this.scope === "worktree" }))
        .child(this.basePicker(t, base, narrow ? Math.max(48, Math.min(180, width - 380)) : 180)),
      this.prsPopup(t),
      h_flex().flex_none().gap(2)
        .child(this.button(t, "view-unified", null, (cx) => { this.split = false; cx.notify(); }, { on: !this.split, iconName: "unified", tip: "Unified" }))
        .child(this.button(t, "view-split", null, (cx) => { this.split = true; cx.notify(); }, { on: this.split, iconName: "split", tip: "Split" }))
        .child(this.button(t, "toggle-all", null, (cx) => this.setAll(anyOpen, cx), anyOpen ? { iconName: "collapse", tip: "Collapse all" } : { iconName: "expand", tip: "Expand all" }))
        .child(this.button(t, "refresh", null, (cx) => { this.ghAt = 0; this.refresh(cx); }, { iconName: "refresh", tip: this.loading ? "Refreshing…" : "Refresh" })),
    ];
    if (!narrow) {
      return h_flex().h(44).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border).children(head).children(controls);
    }
    return v_flex().flex_none().px(12).py(6).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().h(28).gap(10).items_center().children(head))
      .child(h_flex().h(30).gap(10).items_center().min_w(0).overflow_hidden().children(controls));
  }

  // A button with a surface hung under it (right edges lined up) while
  // open; a press outside it, except on the button (which toggles), closes it.
  popup(id, trigger, content = null, close = null) {
    const anchored = Popup.new(`${id}-popup`, trigger.on_hover((on) => { this.over[id] = on; })).anchor("top_right");
    if (!content) return anchored;
    return anchored.content(content.on_mouse_down_out((_e, cx) => {
      if (this.over[id]) return;
      close();
      cx.notify();
    }));
  }

  // "PRs": open pull requests, the ones asking for your review first; one
  // picked starts its review (startPR).
  prsPopup(t) {
    const p = this.prList;
    const trigger = this.button(t, "prs", "PRs ▾", (cx) => this.openPRs(cx), { on: Boolean(p), tip: "Review a pull request (a worktree and a reviewer agent in a new tab)" });
    if (!p) return this.popup("prs", trigger);
    const line = (text, c) => div().p(10).text_size(12).text_color(c).child(text);
    const rows = p.error ? [line(p.error, t.ansi1)] : !p.prs ? [line("Loading pull requests…", t.dim)] : !p.prs.length ? [line("No open pull requests", t.dim)]
      : p.prs.map((pr) => h_flex().id(`pr-${pr.number}`).flex_none().h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.startPR(pr.number, cx))
        .child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        .when(pr.requested, (e) => e.child(div().flex_none().px(6).rounded(5).border_1().border_color(t.accent).text_size(10.5).text_color(t.accent).child("review requested")))
        .when(pr.isDraft, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child("draft")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(p.busy === pr.number ? "Checking out…" : `@${pr.author?.login ?? "?"}`)));
    const menu = v_flex().id("pr-list").w(480).max_h(420).mt(4).p(4).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .overflow_y_scrollbar().text_color(t.foreground).children(rows);
    return this.popup("prs", trigger, menu, () => { this.prList = null; });
  }

  // PR mode's "Review": a summary and the three ways to submit, with the pending comments.
  reviewPopup(t) {
    const n = this.pending().length, r = this.review;
    const own = Boolean(this.me) && this.pr?.author === this.me; // GitHub refuses approving or requesting changes on your own PR
    const trigger = this.button(t, "review", `Review${n ? ` (${n})` : ""} ▾`, (cx) => { this.review = r ? null : { busy: null, error: null }; cx.notify(); }, { on: true, tip: "Submit your review to GitHub" });
    if (!r) return this.popup("review", trigger);
    const act = (event, label) => h_flex().id(`review-${event}`).h(28).px(12).items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.submitReview(event, cx))
      .child(r.busy === event ? "Submitting…" : label);
    const box = v_flex().id("review-box").w(400).mt(4).p(10).gap(8).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_color(t.foreground)
      .child(div().text_size(12).text_color(t.dim).child(n ? `${n} pending comment${n === 1 ? "" : "s"} go with it.` : "No pending comments: click line numbers to add some."))
      .when(own, (e) => e.child(div().text_size(12).text_color(t.dim).child("It's your own PR: GitHub only lets you comment.")))
      .child(div().id("review-summary").h(76).px(8).py(6).rounded(6).border_1().border_color(t.border).bg(t.background).cursor_text()
        .child(Textarea.new(this.reviewInput).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6).child(act("COMMENT", "Comment")).when(!own, (e) => e.child(act("APPROVE", "Approve")).child(act("REQUEST_CHANGES", "Request changes"))))
      .when(Boolean(r.error), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(r.error)));
    return this.popup("review", trigger, box, () => { this.review = null; });
  }

  commitRow(t) {
    const staged = this.files.some((f) => f.cached);
    const ready = Boolean(this.commitInput.value().trim()) && !this.busy;
    return h_flex()
      .flex_none()
      .items_end()
      .px(12)
      .py(8)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        div().id("changes-commit-message").flex_1().min_w(0).min_h(30).px(10).py(6).flex().items_center()
          .rounded(8).border_1().border_color(t.border).cursor_text()
          .child(Textarea.new(this.commitInput).w_full().text_size(12).text_color(t.foreground)),
      )
      .child(
        div().id("changes-commit").h(30).px(12).flex_none().flex().items_center().rounded(8).text_size(12)
          .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim)
          .when(ready, (e) => e.cursor_pointer())
          .on_click((_e, cx) => this.commit(cx))
          .child(this.busy === "commit" ? "Committing…" : staged ? "Commit staged" : "Commit all"),
      );
  }

  // The Base button, with the branch list hung under it (right edges lined up) while picking.
  basePicker(t, base, maxW) {
    // The branch name is cut at `maxW` px so the bar's buttons keep their place; the tooltip has it whole.
    const label = h_flex().gap(4).child(div().max_w(maxW).truncate().child(`Base: ${base}`)).child("▾");
    const trigger = this.button(t, "scope-branch", label, (cx) => (this.scope === "branch" ? this.openPicker(cx) : this.setScope("branch", cx)), { on: this.scope === "branch", tip: `Base: ${base}. Click again to pick another branch` });
    const p = this.picker;
    if (!p) return this.popup("base", trigger);
    const row = (id, label, onPress, on = false) =>
      div().id(id).flex_none().h(26).px(10).flex().items_center().rounded(6).cursor_pointer().text_size(12)
        .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => onPress(cx)).child(div().min_w(0).truncate().child(label));
    const list = p.error ? [div().p(10).text_size(12).text_color(t.ansi1).child(p.error)]
      : !p.branches ? [div().p(10).text_size(12).text_color(t.dim).child("Loading branches…")]
      : [row("base-default", "Default base (main / master / origin's)", (cx) => this.setBase(null, cx), !this.pickedBase),
        ...p.branches.filter((b) => b !== this.status?.branch).map((b, i) => row(`base-${i}`, b, (cx) => this.setBase(b, cx), b === this.pickedBase))];
    const menu = v_flex().id("picker").w(320).max_h(360).mt(4).p(4).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).shadow_lg().overflow_y_scrollbar()
      .text_color(t.foreground)
      .children(list);
    return this.popup("base", trigger, menu, () => { this.picker = null; });
  }

  item(item, t, cx) {
    if (!item) return div();
    if (item.gap) return div().h(GAP).flex_none();
    if (item.end) return div().h(END).flex_none().w_full().border_x_1().border_b_1().border_color(t.border).rounded_b(8);
    if (item.head) return this.header(item.f, t, item.count);
    if (item.thread) return threadView(this, item, t);
    if (item.composer) return composerView(this, item, t);
    if (item.msg) return div().h(MSG).flex_none().flex().items_center().px(16).text_size(12).text_color(t.dim).border_x_1().border_color(t.border).child(item.msg);
    const f = item.f;
    const frame = (e, ri) => e.id(`row-${f.key}-${ri}`).h(ROW).flex_none().w_full().overflow_hidden().border_x_1().border_color(t.border)
      .on_mouse_move((_e, cx) => this.dragOver(f, ri, cx));
    if (item.row) {
      const r = item.row;
      if (r.k === "fold") return this.fold(r, f, t, cx);
      return frame(h_flex(), item.ri).child(this.side(r, r.n ?? r.o, t, f, item.ri));
    }
    const p = item.pair;
    if (p.across) return this.fold(p.across, f, t, cx);
    const at = (row) => (row ? this.diffs.get(f.key)?.index?.get(row) ?? -1 : -1);
    return frame(h_flex(), at(p.r ?? p.l))
      .child(this.side(p.l, p.l?.o, t, f, at(p.l), "l"))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.side(p.r, p.r?.n, t, f, at(p.r), "r"));
  }

  fold(r, f, t, cx) {
    const text = codeSpans(r).map(([s]) => s).join("").trim() || "⋯ unchanged lines";
    return div().id(`fold-${f.key}-${r.m ?? ""}-${text}`).h(ROW).flex_none().w_full().flex().items_center().px(GUTTER)
      .bg(color("@fold", t)).text_color(t.muted).cursor_pointer().border_x_1().border_color(t.border)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.unfold(f, cx))
      .child(nbsp(text.replace("click to expand", "click to show the whole file")));
  }

  // One side of a line: marker, number, then the code (moved by the
  // sideways scroll). `row` null: the empty side of an add or delete.
  // `ri`: the row's index in the file's diff; its number starts a comment.
  side(row, num, t, f, ri, half = "u") {
    if (!row) return div().flex_1().min_w(0).h_full().bg(`${String(t.foreground).slice(0, 7)}08`);
    const picked = this.inSelection(f, ri);
    const bg = picked ? t.selection : row.bg ? color(row.bg, t) : null;
    const mark = row.k === "add" ? t.ansi2 : row.k === "del" ? t.ansi1 : null;
    const left = Math.round(this.scroll.left);
    return h_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .relative()
      .overflow_hidden()
      .when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(3).h_full().flex_none().when(Boolean(mark), (e) => e.bg(mark)))
      .child(
        div().id(`num-${f.key}-${ri}-${half}`).w(GUTTER - 3).h_full().flex_none().flex().items_center().justify_end().pr(10).text_color(mark ?? t.dim)
          .cursor_pointer().hover((s) => s.bg(t.accent).text_color(t.accent_foreground))
          .tooltip("Comment on this line (drag for more)")
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressLine(f, ri, Boolean(e.modifiers?.shift), cx); })
          .child(num == null ? "" : String(num)),
      )
      .child(
        div().flex_1().min_w(0).h_full().relative().overflow_hidden().child(
          h_flex().absolute().top_0().bottom_0().left(-left).items_center().children(
            codeSpans(row).map(([text, fg, sbg]) => {
              const own = Boolean(sbg) && sbg !== row.bg;
              const behind = [bg, own && color(sbg, t)].filter(Boolean);
              return div().flex_none().child(nbsp(text))
                .when(Boolean(fg), (e) => e.text_color(readable(color(fg, t), behind, t)))
                .when(own, (e) => e.bg(color(sbg, t)));
            }),
          ),
        ),
      );
  }

  header(f, t, count = 0) {
    const open = !this.isCollapsed(f.key);
    const slash = f.path.lastIndexOf("/");
    const name = f.path.slice(slash + 1), dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
    const tint = f.kind === "deleted" ? t.ansi1 : f.kind === "added" || f.kind === "untracked" ? t.ansi2 : f.kind === "conflicted" ? t.blocked : t.foreground;
    const worktree = this.scope === "worktree";
    const confirming = this.confirming?.key === f.key && Date.now() < this.confirming.until;
    const busy = this.busy === f.key;
    return h_flex()
      .id(`head-${f.key}`)
      .h(HEAD)
      .flex_none()
      .w_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.surface ?? t.raised)
      .border_1()
      .border_color(t.border)
      .when(!open, (e) => e.rounded(8))
      .when(open, (e) => e.rounded_t(8))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(f, cx))
      .child(icon(open ? "chevron-down" : "chevron-right", 13, t.muted))
      .child(
        div().flex_none().px(6).py(1).rounded(5).bg(t.raised).text_size(12.5).font_semibold().text_color(tint)
          .when(f.kind === "deleted", (e) => e.line_through())
          .child(name),
      )
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(dir))
      .when(count > 0, (e) => e.child(div().flex_none().px(6).py(1).rounded(5).border_1().border_color(t.accent).text_size(10.5).text_color(t.accent).child(`${count} comment${count === 1 ? "" : "s"}`)))
      .when(worktree && f.cached, (e) => e.child(div().flex_none().px(6).py(1).rounded(5).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).child("staged")))
      .when(f.kind === "untracked", (e) => e.child(div().flex_none().text_size(10.5).text_color(t.muted).child("new")))
      .when((f.add ?? 0) > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`+${f.add}`)))
      .when((f.del ?? 0) > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`−${f.del}`)))
      .when(busy, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.dim).child("…")))
      .when(worktree && !busy, (e) => e
        .child(this.button(t, `stage-${f.key}`, f.cached ? "Unstage" : "Stage", (cx) => this.act(f.cached ? "unstage" : "stage", f, cx)))
        .when(!f.cached, (e) => e.child(this.button(t, `discard-${f.key}`, confirming ? "Really discard?" : "Discard", (cx) => this.act("discard", f, cx), { danger: confirming }))))
      .when(f.kind !== "deleted", (e) => e.child(this.button(t, `open-${f.key}`, "Open File", () => this.openFile(f))));
  }
}
