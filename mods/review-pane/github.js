// Pull request reviews through GitHub's `gh` CLI, on the repo's machine:
// the open PRs, a PR checked out in a worktree of its own, its review
// comments as threads, and submitting a review (pending comments plus
// Comment, Approve or Request changes). Agents only ever answer here; the
// review is posted by the person.

import { appHome, exec, readTextFile } from "herdr";
import { git } from "./engine.js";

const GH = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
const ghBin = new Map(); // machine ("" here) -> the gh that ran

async function gh(args, { cwd, on }) {
  const known = ghBin.get(on ?? "");
  for (const bin of known ? [known] : GH) {
    let r;
    try { r = await exec(bin, args, { cwd, on, timeout: 120000 }); } catch { continue; }
    if (r.code === 127) continue;
    ghBin.set(on ?? "", bin);
    if (r.code !== 0) throw failure(r, `gh ${args[0]} failed`);
    return r.stdout;
  }
  throw new Error("GitHub's gh CLI isn't installed on this machine (or isn't on PATH)");
}

// GitHub's own words for a failed call: `gh api` prints the response body
// (REST `errors` strings or objects, GraphQL `errors[].message`), while its
// stderr only has the status ("Unprocessable Entity (HTTP 422)").
function failure(r, what) {
  try {
    const body = JSON.parse(r.stdout);
    const detail = (body.errors ?? []).map((e) => (typeof e === "string" ? e : e?.message)).filter(Boolean);
    if (detail.length || body.message) return new Error(detail.length ? detail.join("; ") : body.message);
  } catch { /* not JSON */ }
  return new Error((r.stderr || r.stdout || what).trim());
}

const logins = new Map(); // machine ("" here) -> the GitHub account gh uses there

export async function viewerLogin(w) {
  if (!logins.has(w.on ?? "")) logins.set(w.on ?? "", (await gh(["api", "user", "-q", ".login"], w)).trim());
  return logins.get(w.on ?? "");
}

// UTF-8 base64 (the runtime has btoa but no TextEncoder).
const b64 = (s) => btoa(encodeURIComponent(s).replace(/%([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))));

async function sh(script, args, { cwd, on }) {
  const r = await exec("/bin/sh", ["-c", script, "sh", ...args], { cwd, on, timeout: 120000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "failed").trim());
  return r.stdout;
}

export const writeFile = (path, text, w) => sh('mkdir -p "$(dirname "$1")" && printf %s "$2" | base64 -d > "$1"', [path, b64(text)], w);

export async function repoSlug(w) {
  return (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], w)).trim();
}

// Open PRs, the ones asking for your review first, then the most recently updated.
export async function listPRs(w) {
  const fields = "number,title,author,headRefName,baseRefName,isDraft,url,updatedAt";
  const [all, asked] = await Promise.all([
    gh(["pr", "list", "--state", "open", "--limit", "60", "--json", fields], w),
    gh(["pr", "list", "--state", "open", "--search", "review-requested:@me", "--json", "number"], w).catch(() => "[]"),
  ]);
  const wanted = new Set(JSON.parse(asked).map((p) => p.number));
  return JSON.parse(all)
    .map((p) => ({ ...p, requested: wanted.has(p.number) }))
    .sort((a, b) => Number(b.requested) - Number(a.requested) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// One PR by number (open or not), shaped like listPRs' entries.
export async function viewPR(number, w) {
  return { ...JSON.parse(await gh(["pr", "view", String(number), "--json", "number,title,author,headRefName,baseRefName,isDraft,url,updatedAt"], w)), requested: false };
}

// Where worktrees go (the worktree mod's setting), on the repo's machine.
async function worktreesDir(w) {
  const raw = await readTextFile(`${appHome()}/settings.json`).catch(() => null);
  let dir = (raw ? JSON.parse(raw) : {})?.worktrees?.directory ?? "~/.herdr/worktrees";
  if (dir === "~" || dir.startsWith("~/")) dir = (await sh('printf %s "$HOME"', [], w)).replace(/\/$/, "") + dir.slice(1);
  return dir.replace(/\/+$/, "");
}

// The PR's head in a worktree of its own (made, or moved to the PR's latest
// head), its base fetched, and what the review needs written beside it
// (<git dir>/herdr-review/pr.json, read back when the pane opens there again).
export async function checkoutPR(pr, { root, on }) {
  const w = { cwd: root, on };
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], w)).trim();
  const main = common.endsWith("/.git") ? common.slice(0, -5) : root;
  const repo = await repoSlug({ cwd: main, on });
  const dir = `${await worktreesDir(w)}/${main.split("/").pop()}/pr-${pr.number}`;
  const ref = `refs/herdr/pr/${pr.number}`;
  await git(["fetch", "--quiet", "origin", `+refs/pull/${pr.number}/head:${ref}`, `+refs/heads/${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`], { cwd: main, on });
  const listed = (await git(["worktree", "list", "--porcelain"], { cwd: main, on })).split("\n").includes(`worktree ${dir}`);
  if (listed) await git(["checkout", "--quiet", "--detach", ref], { cwd: dir, on });
  else await git(["worktree", "add", "--quiet", "--detach", dir, ref], { cwd: main, on });
  const head = (await git(["rev-parse", "HEAD"], { cwd: dir, on })).trim();
  const info = { number: pr.number, title: pr.title, url: pr.url, author: pr.author?.login ?? null, base: pr.baseRefName, headRef: pr.headRefName, head, repo };
  const gitdir = (await git(["rev-parse", "--absolute-git-dir"], { cwd: dir, on })).trim();
  await writeFile(`${gitdir}/herdr-review/pr.json`, JSON.stringify(info, null, 2), { cwd: dir, on });
  return { dir, info };
}

export async function readPR(gitdir, on) {
  const r = await exec("cat", [`${gitdir}/herdr-review/pr.json`], { on, timeout: 10000 });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const graphql = (query, vars, w) => gh(["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => [typeof v === "number" ? "-F" : "-f", `${k}=${v}`])], w);

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    id isResolved isOutdated path line startLine diffSide startDiffSide
    comments(first: 100) { nodes { body createdAt author { login } } }
  } } } }
}`;

// The PR's review threads (GitHub's own conversations): resolved or not,
// outdated or not, and the node id that replying and resolving take.
export async function prThreads(pr, w) {
  const [owner, name] = pr.repo.split("/");
  const data = JSON.parse(await graphql(THREADS, { owner, name, number: pr.number }, w));
  return (data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((t) => {
    const side = t.diffSide === "LEFT" ? "old" : "new";
    return {
      id: `gh-${t.id}`, gh: true, node: t.id, resolved: t.isResolved, outdated: t.isOutdated,
      file: t.path, side, line: t.line ?? null, startSide: t.startDiffSide === "LEFT" ? "old" : t.startDiffSide ? "new" : side, startLine: t.startLine ?? t.line ?? null,
      snippet: "", kind: "github",
      thread: t.comments.nodes.map((c) => ({ who: `@${c.author?.login ?? "ghost"}`, text: c.body ?? "", at: c.createdAt })),
    };
  });
}

// Posts a reply to a review thread at once (not part of a pending review).
export const replyToThread = (node, body, w) => graphql(
  "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }",
  { id: node, body }, w);

export const setResolved = (node, resolved, w) => graphql(
  `mutation($id: ID!) { ${resolved ? "resolveReviewThread" : "unresolveReviewThread"}(input: {threadId: $id}) { thread { isResolved } } }`,
  { id: node }, w);

// Posts the review: `event` COMMENT, APPROVE or REQUEST_CHANGES, with the
// pending comments (threads of kind "comment") on the head it was read at.
export async function submitReview(pr, { event, body, comments }, w) {
  const payload = {
    commit_id: pr.head, event, body: body || undefined,
    comments: comments.map((n) => {
      const one = { path: n.file, body: n.thread[0].text, line: n.line, side: n.side === "old" ? "LEFT" : "RIGHT" };
      if (n.startLine != null && (n.startLine !== n.line || n.startSide !== n.side)) Object.assign(one, { start_line: n.startLine, start_side: n.startSide === "old" ? "LEFT" : "RIGHT" });
      return one;
    }),
  };
  await gh(["--version"], w); // finds gh on that machine
  const r = await exec("/bin/sh", ["-c", 'printf %s "$2" | base64 -d | "$1" api -X POST "$3" --input -', "sh", ghBin.get(w.on ?? ""), b64(JSON.stringify(payload)), `repos/${pr.repo}/pulls/${pr.number}/reviews`], { ...w, timeout: 120000 });
  if (r.code !== 0) throw failure(r, "submitting the review failed");
  return r.stdout;
}
