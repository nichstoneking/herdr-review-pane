// The git engine: plain `git` run on the repo's machine (exec's `on`), read
// into what the pane draws: the status (sections of changed files), a file's
// diff as rows with syntax colors and changed-word emphasis, and the actions
// (stage, unstage, discard, commit, the editor, sending text to a terminal).
// Its shapes and choices (sections, the fork-base guess, folds) follow
// herdr-gitview's engine (github.com/ChmaraX/herdr-gitview, MIT), ported to
// JavaScript so the mod needs no program of its own.

import { exec, hc } from "herdr";
import { highlight, languageOf } from "./highlight.js";

export const message = (e) => String(e?.message ?? e ?? "unknown error");

const CONTEXT = 3;         // lines around each change
const MAX_ROWS = 6000;     // a diff longer than this is cut
const MAX_COUNTED = 400;   // untracked files whose lines are counted (and hashed)

async function run(cmd, args, { cwd, on }, ok = [0]) {
  const r = await exec(cmd, args, { cwd, on, timeout: 60000 });
  if (!ok.includes(r.code)) throw new Error((r.stderr || r.stdout || `${cmd} ${args[0]} failed`).trim());
  return r.stdout;
}

// Plain git in the repo, on its machine. `ok`: the exit codes that aren't failures.
export const git = (args, w, ok) => run("git", ["--no-optional-locks", "-c", "core.quotepath=off", ...args], w, ok);

const KIND = { M: "modified", T: "modified", A: "added", D: "deleted", U: "conflicted" };

// ---- status -------------------------------------------------------------------

// The repo's changed files: {root, branch, head, sections: [{id, title,
// cached, files: [{path, orig, kind, letter, add, del, rev}]}], base?}.
// scope "worktree": staged and unstaged (untracked with them) as two
// sections; "branch": the working tree against the merge-base with `picked`
// (or the branch this one forked from) as one.
export async function status({ cwd, on }, scope, picked = null) {
  const root = (await git(["rev-parse", "--show-toplevel"], { cwd, on })).trim();
  const w = { cwd: root, on };
  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], w, [0, 1])).trim() || null;
  const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], w, [0, 1])).trim() || null;
  const tree = await worktree(w, Boolean(head));
  if (scope !== "branch") {
    return { root, branch, head, sections: [
      { id: "staged", title: "staged changes", cached: true, files: tree.staged },
      { id: "changes", title: "changes", cached: false, files: [...tree.changes, ...tree.untracked] },
    ].filter((s) => s.files.length) };
  }
  const label = picked ?? (await cachedForkBase(w, branch, head)) ?? "HEAD";
  const mb = (await git(["merge-base", "HEAD", label], w)).trim();
  const nums = numstat(await git(["diff", "--no-renames", "--numstat", "-z", mb], w));
  const names = (await git(["diff", "--no-renames", "--name-status", "-z", mb], w)).split("\0");
  const files = [];
  for (let i = 0; i + 1 < names.length; i += 2) {
    const letter = names[i][0], path = names[i + 1];
    if (!path) continue;
    const n = nums.get(path) ?? { add: 0, del: 0 };
    files.push({ path, orig: null, kind: KIND[letter] ?? "modified", letter, ...n, rev: `${mb}:${n.add}:${n.del}` });
  }
  await stamp(w, files.filter((f) => f.kind !== "deleted"));
  files.push(...tree.untracked);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, branch, head, base: { label, merge_base: mb }, sections: [{ id: "branch", title: "", cached: false, files }] };
}

// `git status` read into staged, unstaged and untracked files, with counts and stamps.
async function worktree(w, born) {
  const raw = (await git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"], w)).split("\0");
  const staged = [], changes = [], untracked = [];
  for (const rec of raw) {
    if (rec[0] === "1") {
      const parts = rec.split(" "), xy = parts[1], path = parts.slice(8).join(" ");
      if (xy[0] !== ".") staged.push({ path, orig: null, kind: KIND[xy[0]] ?? "modified", letter: xy[0], rev: parts[7] });
      if (xy[1] !== ".") changes.push({ path, orig: null, kind: KIND[xy[1]] ?? "modified", letter: xy[1] });
    } else if (rec[0] === "u") {
      changes.push({ path: rec.split(" ").slice(10).join(" "), orig: null, kind: "conflicted", letter: "U" });
    } else if (rec[0] === "?") {
      untracked.push({ path: rec.slice(2), orig: null, kind: "untracked", letter: "U" });
    }
  }
  const [cachedNums, nums] = await Promise.all([
    born ? git(["diff", "--cached", "--no-renames", "--numstat", "-z"], w).then(numstat) : new Map(),
    git(["diff", "--no-renames", "--numstat", "-z"], w).then(numstat),
  ]);
  for (const f of staged) Object.assign(f, cachedNums.get(f.path) ?? { add: 0, del: 0 });
  for (const f of changes) Object.assign(f, nums.get(f.path) ?? { add: 0, del: 0 });
  if (!born) for (const f of staged) Object.assign(f, { add: null, del: 0 });
  await countLines(w, untracked.slice(0, MAX_COUNTED));
  await stamp(w, [...changes.filter((f) => f.kind !== "deleted"), ...untracked.slice(0, MAX_COUNTED)]);
  for (const f of [...changes, ...untracked]) f.rev ??= `${f.kind}:${f.add}:${f.del}`;
  staged.sort((a, b) => a.path.localeCompare(b.path));
  return { staged, changes, untracked };
}

function numstat(out) {
  const map = new Map();
  for (const rec of out.split("\0")) {
    const [a, d, path] = rec.split("\t");
    if (path) map.set(path, a === "-" ? { add: 0, del: 0, binary: true } : { add: Number(a) || 0, del: Number(d) || 0 });
  }
  return map;
}

// Untracked files' line counts (their "+N").
async function countLines(w, files) {
  if (!files.length) return;
  const out = await run("/bin/sh", ["-c", "for f; do if [ -f \"$f\" ]; then awk 'END { print NR }' \"$f\"; else echo 0; fi; done", "sh", ...files.map((f) => f.path)], w).catch(() => "");
  out.split("\n").forEach((n, i) => { if (files[i]) Object.assign(files[i], { add: Number(n.trim()) || 0, del: 0 }); });
}

// What a file's content is now (git's hash of the working copy), so a diff
// reloads when the file changes even if its counts don't.
async function stamp(w, files) {
  if (!files.length) return;
  const out = await git(["hash-object", "--", ...files.map((f) => f.path)], w).catch(() => "");
  out.split("\n").forEach((h, i) => { if (files[i] && h) files[i].rev = `${files[i].rev ?? ""}:${h}`; });
}

const TRUNKS = ["origin/main", "origin/master", "origin/next", "origin/develop", "main", "master", "next", "develop"];
const isTrunk = (name) => TRUNKS.some((t) => t === name || t.endsWith(`/${name}`));
const rank = (name) => { const i = TRUNKS.indexOf(name); return i < 0 ? TRUNKS.length : i; };

// The fork-base guess walks refs, so it's kept per repo, branch and head.
const bases = new Map();
async function cachedForkBase(w, branch, head) {
  const key = `${w.on ?? ""}:${w.cwd}:${branch}:${head}`;
  if (!bases.has(key)) bases.set(key, await forkBase(w, branch, head));
  return bases.get(key);
}

// The branch this one was cut from: the ref with the fewest commits between
// it (or its merge-base) and HEAD, trunks winning ties; a trunk's own trunk.
async function forkBase(w, branch, head) {
  if (!head || (branch && isTrunk(branch))) return trunk(w);
  const remotes = (await git(["remote"], w)).split("\n").filter(Boolean);
  const own = (name) => Boolean(branch) && (name === branch || remotes.some((r) => name === `${r}/${branch}`));
  const between = async (from) => Number((await git(["rev-list", "--count", "--max-count=500", `${from}..HEAD`], w, [0, 128])).trim()) || 0;
  const scored = [];
  const merged = (await git(["for-each-ref", "--merged", "HEAD", "--sort=-committerdate", "--count=50", "--format=%(refname:short)", "refs/heads", "refs/remotes"], w))
    .split("\n").filter((n) => n && !n.endsWith("/HEAD") && !own(n));
  for (const name of merged) {
    const d = await between(name);
    if (d > 0) scored.push([d, rank(name), name.length, name]);
  }
  const existing = new Set((await git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], w)).split("\n"));
  const origin = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], w, [0, 1])).trim();
  for (const name of new Set([origin, ...TRUNKS].filter((n) => n && existing.has(n) && !own(n)))) {
    const mb = (await git(["merge-base", "HEAD", name], w, [0, 1])).trim();
    if (!mb || mb === head) continue;
    const d = await between(mb);
    if (d > 0) scored.push([d, rank(name), name.length, name]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]));
  return scored[0]?.[3] ?? trunk(w);
}

async function trunk(w) {
  const origin = (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], w, [0, 1])).trim();
  if (origin) return origin;
  for (const name of ["origin/main", "origin/master", "main", "master"]) {
    if ((await git(["rev-parse", "--verify", "--quiet", name], w, [0, 1])).trim()) return name;
  }
  return null;
}

// ---- diff ---------------------------------------------------------------------

// One file's diff as rows: {k: "ctx" | "add" | "del" | "fold", o, n (line
// numbers), m (the marker and text), bg, s: [[text, color, bg]]}, plus
// first (the first changed line), binary, empty and truncated.
// `mergeBase`: against that commit (branch scope); `unfold`: the whole file.
export async function diff(w, f, { cached = false, mergeBase = null, unfold = false, dark = true } = {}) {
  const flags = ["--no-color", "--no-ext-diff", "--no-renames", unfold ? "-U100000000" : `-U${CONTEXT}`];
  const args = f.kind === "untracked" ? ["diff", ...flags, "--no-index", "--", "/dev/null", f.path]
    : cached ? ["diff", "--cached", ...flags, "--", f.path]
      : ["diff", ...flags, ...(mergeBase ? [mergeBase] : []), "--", f.path];
  const out = await git(args, w, [0, 1]);
  if (/^Binary files .* differ$/m.test(out) || /^GIT binary patch$/m.test(out)) return { rows: [], binary: true };
  const hunks = parse(out);
  if (!hunks.length) return { rows: [], empty: true };
  const total = unfold ? null : await lineCount(w, f, cached).catch(() => null);
  return { ...draw(hunks, languageOf(f.path), dark, total), binary: false, empty: false };
}

function parse(out) {
  const hunks = [];
  let h = null;
  for (const line of out.split("\n")) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      h = { o: Number(head[1]), n: Number(head[3]), lines: [] };
      hunks.push(h);
    } else if (h && (line[0] === " " || line[0] === "+" || line[0] === "-")) {
      h.lines.push(line);
    }
  }
  return hunks;
}

// The new side's length (the old side's for a deletion), for the fold after the last change.
async function lineCount(w, f, cached) {
  const count = "awk 'END { print NR }'";
  const script = f.kind === "deleted" ? `git show "HEAD:$1" | ${count}` : cached ? `git show ":$1" | ${count}` : `${count} "$1"`;
  return Number((await run("/bin/sh", ["-c", script, "sh", f.path], w)).trim()) || null;
}

const tabs = (s) => s.replace(/\t/g, "    ");
const fold = (count, at) => ({ k: "fold", m: `fold:${at}`, s: [[`⋯ ${count} unchanged line${count === 1 ? "" : "s"} — click to expand`, "@fold_fg", null]] });

function draw(hunks, lang, dark, total) {
  const rows = [];
  const state = { o: {}, n: {} };
  let lastN = 0, first = null, truncated = false;
  for (const h of hunks) {
    const gap = h.n - 1 - lastN;
    if (gap > 0) rows.push(fold(gap, h.n));
    let o = h.o, n = h.n;
    // Runs of deletions then additions, so changed words can be marked between them.
    for (let i = 0; i < h.lines.length;) {
      const line = h.lines[i];
      if (line[0] === " ") {
        const text = tabs(line.slice(1));
        const spans = highlight(text, lang, dark, state.n);
        highlight(text, lang, dark, state.o);
        rows.push({ k: "ctx", o: o++, n: n++, m: line, bg: null, s: spans.map(([t, c]) => [t, c, null]) });
        i++;
        continue;
      }
      const dels = [], adds = [];
      while (i < h.lines.length && h.lines[i][0] === "-") dels.push(h.lines[i++]);
      while (i < h.lines.length && h.lines[i][0] === "+") adds.push(h.lines[i++]);
      first ??= adds.length ? n : o;
      const marks = dels.map((d, j) => (adds[j] != null ? changed(tabs(d.slice(1)), tabs(adds[j].slice(1))) : null));
      dels.forEach((d, j) => {
        const text = tabs(d.slice(1));
        rows.push({ k: "del", o: o++, n: null, m: d, bg: "@del", s: emphasize(highlight(text, lang, dark, state.o), marks[j]?.old, "@del", "@del_emph") });
      });
      adds.forEach((a, j) => {
        const text = tabs(a.slice(1));
        rows.push({ k: "add", o: null, n: n++, m: a, bg: "@ins", s: emphasize(highlight(text, lang, dark, state.n), marks[j]?.new, "@ins", "@ins_emph") });
      });
    }
    lastN = n - 1;
    if (rows.length > MAX_ROWS) { truncated = true; break; }
  }
  const after = total == null ? 0 : total - Math.max(lastN, 0);
  if (!truncated && after > 0 && lastN > 0) rows.push(fold(after, lastN + 1));
  return { rows: rows.slice(0, MAX_ROWS), first_change: first, truncated };
}

// The part of a changed line that differs from its pair (common start and
// end trimmed), or nothing when the two have too little in common.
function changed(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  if (s + e < Math.min(a.length, b.length) * 0.3) return null;
  return { old: [s, a.length - e], new: [s, b.length - e] };
}

function emphasize(spans, range, bg, strong) {
  const out = [];
  let at = 0;
  for (const [text, c] of spans) {
    const end = at + text.length;
    if (!range || range[1] <= at || range[0] >= end || range[0] === range[1]) {
      out.push([text, c, bg]);
    } else {
      const a = Math.max(range[0], at) - at, b = Math.min(range[1], end) - at;
      if (a > 0) out.push([text.slice(0, a), c, bg]);
      out.push([text.slice(a, b), c, strong]);
      if (b < text.length) out.push([text.slice(b), c, bg]);
    }
    at = end;
  }
  return out;
}

// ---- actions ------------------------------------------------------------------

// Stage, unstage or discard one file of a section.
export async function act(op, f, section, w) {
  if (op === "stage") return git(["add", "-A", "--", f.path], w);
  if (op === "unstage") return git(["restore", "--staged", "--", f.path], w).catch(() => git(["rm", "--cached", "-r", "--quiet", "--", f.path], w));
  if (op === "discard") {
    if (f.kind === "untracked") return git(["clean", "-f", "-q", "--", f.path], w);
    if (section === "staged") throw new Error("unstage it first");
    return git(["restore", "--", f.path], w);
  }
  throw new Error(`unknown action ${op}`);
}

// Commits the staged changes, or everything (untracked too) when nothing is
// staged; resolves with the new commit's one-line summary.
export async function commit(text, w) {
  if ((await git(["ls-files", "--unmerged"], w)).trim()) throw new Error("resolve the merge conflicts first");
  const staged = (await git(["diff", "--cached", "--name-only"], w)).trim();
  if (!staged) await git(["add", "-A"], w);
  await git(["commit", "-q", "-m", text], w);
  return (await git(["log", "-1", "--format=%h %s"], w)).trim();
}

const EDITORS = ["nvim", "vim", "vi", "hx", "nano", "emacs"];

// The editor to open files in on that machine: $VISUAL, $EDITOR (from the
// login shell), else the first of EDITORS installed. {argv, kind} or null.
export async function editor(w) {
  const script = 'printf "V:%s\\nE:%s\\n" "$VISUAL" "$EDITOR"; for n in "${VISUAL%% *}" "${EDITOR%% *}" ' + EDITORS.join(" ") + '; do [ -n "$n" ] && p=$(command -v "$n") && printf "P:%s=%s\\n" "$n" "$p"; done; true';
  const out = await run("/bin/sh", ["-c", `exec "\${SHELL:-/bin/sh}" -lc '${script.replace(/'/g, "'\\''")}'`], w).catch(() => "");
  const lines = out.split("\n");
  const env = (k) => (lines.find((l) => l.startsWith(`${k}:`)) ?? "").slice(2).trim();
  const paths = new Map(lines.filter((l) => l.startsWith("P:")).map((l) => { const [n, ...p] = l.slice(2).split("="); return [n, p.join("=")]; }));
  for (const argv of [env("V"), env("E"), ...EDITORS].filter(Boolean).map((s) => s.split(/\s+/))) {
    const path = paths.get(argv[0]);
    if (path) return { argv: [path, ...argv.slice(1)], kind: argv[0].split("/").pop() };
  }
  return null;
}

// Types text into a terminal (any machine's address) and presses enter.
export async function send(terminal, text) {
  const r = await hc(["send", terminal, text.replace(/\n+$/, "")]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc send failed").trim());
}
