// A small syntax highlighter for diff lines: comments, strings, numbers,
// keywords, types, function calls and object keys, by file extension. It
// reads one line at a time and carries block comments and multi-line strings
// to the next line of the same side. Colors are One Dark / One Light.

const C_LIKE = {
  line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"], multi: ["`"],
  keywords: "abstract as async await break case catch class const continue debugger default defer delete do else enum export extends final finally fn for from func function get go goto if impl implements import in instanceof interface internal let loop match mod module move mut namespace new of override package private protected pub public readonly ref return satisfies select set sizeof static struct super switch this throw throws trait try type typeof union unsafe use using var virtual void volatile where while with yield",
};
const HASH = {
  line: ["#"], block: [], quotes: ['"', "'"], multi: [],
  keywords: "alias and as assert async await begin break case class def del do done elif else elsif end ensure esac except export fi finally for from function global if import in is lambda local module next nonlocal not or pass raise redo rescue retry return self then unless until when while with yield",
};
const LANGS = {
  c: C_LIKE,
  python: { ...HASH, quotes: ['"""', "'''", '"', "'"], multi: ['"""', "'''"] },
  hash: HASH,
  json: { line: [], block: [], quotes: ['"'], multi: [], keywords: "", keys: true },
  yaml: { line: ["#"], block: [], quotes: ['"', "'"], multi: [], keywords: "", keys: true },
  css: { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], multi: [], keywords: "important media import include mixin extend if else each for return use forward", keys: true },
  html: { line: [], block: [["<!--", "-->"]], quotes: ['"', "'"], multi: [], keywords: "", tags: true },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: ["'", '"'], multi: [], keywords: "select from where and or not insert into values update set delete create table alter drop index on join left right inner outer group by order limit offset as having union all distinct case when then else end null primary key foreign references default begin commit returning with", nocase: true },
  lua: { line: ["--"], block: [["--[[", "]]"]], quotes: ['"', "'"], multi: [], keywords: "and break do else elseif end for function goto if in local not or repeat return then until while" },
  markdown: { line: [], block: [], quotes: ["`"], multi: [], keywords: "", markdown: true },
};
const BY_EXT = {
  js: "c", mjs: "c", cjs: "c", jsx: "c", ts: "c", tsx: "c", mts: "c", cts: "c", java: "c", kt: "c", kts: "c", scala: "c",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", cs: "c", go: "c", rs: "c", swift: "c", dart: "c", php: "c", zig: "c", proto: "c",
  py: "python", rb: "hash", sh: "hash", bash: "hash", zsh: "hash", fish: "hash", toml: "hash", ini: "hash", conf: "hash", r: "hash", pl: "hash",
  ex: "hash", exs: "hash", nix: "hash", tf: "hash", hcl: "hash", mk: "hash", cmake: "hash", dockerfile: "hash", gitignore: "hash", env: "hash",
  json: "json", jsonc: "json", lock: "json", yml: "yaml", yaml: "yaml", css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html", sql: "sql", lua: "lua", md: "markdown", mdx: "markdown",
};
const BY_NAME = { dockerfile: "hash", makefile: "hash", gemfile: "hash", rakefile: "hash", justfile: "hash", ".gitignore": "hash", ".env": "hash" };

export function languageOf(path) {
  const name = path.split("/").pop().toLowerCase();
  if (BY_NAME[name]) return LANGS[BY_NAME[name]];
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return LANGS[BY_EXT[ext]] ?? null;
}

const DARK = { keyword: "#c678dd", string: "#98c379", comment: "#7f848e", number: "#d19a66", func: "#61afef", type: "#e5c07b", key: "#e06c75", constant: "#d19a66" };
const LIGHT = { keyword: "#a626a4", string: "#50a14f", comment: "#a0a1a7", number: "#986801", func: "#4078f2", type: "#c18401", key: "#e45649", constant: "#986801" };
const CONSTANTS = new Set("true false null nil None True False undefined NaN Infinity self".split(" "));
const words = new Map();
const keywordsOf = (L) => {
  if (!words.has(L)) words.set(L, new Set(L.keywords.split(" ").filter(Boolean)));
  return words.get(L);
};

// Spans [text, color or null] for one line; `state` ({block, quote}) carries
// an open block comment or multi-line string to the next line.
export function highlight(line, L, dark, state = {}) {
  if (!L) return [[line, null]];
  const pal = dark ? DARK : LIGHT, kw = keywordsOf(L), out = [];
  const push = (text, c) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[1] === c) last[0] += text;
    else out.push([text, c]);
  };
  let i = 0;
  if (L.markdown && /^\s{0,3}#{1,6}\s/.test(line)) return [[line, pal.keyword]];
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf(state.block, i);
      const stop = end < 0 ? line.length : end + state.block.length;
      push(line.slice(i, stop), pal.comment);
      i = stop;
      if (end >= 0) state.block = null;
      continue;
    }
    if (state.quote) {
      const stop = closeQuote(line, i, state.quote);
      push(line.slice(i, stop < 0 ? line.length : stop), pal.string);
      i = stop < 0 ? line.length : stop;
      if (stop >= 0) state.quote = null;
      continue;
    }
    const rest = line.slice(i);
    if (L.line.some((p) => rest.startsWith(p) && (p !== "#" || i === 0 || /\s/.test(line[i - 1])))) { push(rest, pal.comment); break; }
    const block = L.block.find(([open]) => rest.startsWith(open));
    if (block) {
      push(block[0], pal.comment);
      i += block[0].length;
      state.block = block[1];
      continue;
    }
    const q = L.quotes.find((x) => rest.startsWith(x));
    if (q) {
      const stop = closeQuote(line, i + q.length, q);
      const end = stop < 0 ? line.length : stop;
      const text = line.slice(i, end);
      const isKey = L.keys && /^\s*:/.test(line.slice(end));
      push(text, isKey ? pal.key : pal.string);
      i = end;
      if (stop < 0 && L.multi.includes(q)) state.quote = q;
      continue;
    }
    const num = /^(0[xob][0-9a-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)/i.exec(rest);
    if (num && (i === 0 || !/[\w$]/.test(line[i - 1]))) { push(num[0], pal.number); i += num[0].length; continue; }
    if (L.tags && rest[0] === "<") {
      const tag = /^<\/?[A-Za-z][\w.:-]*/.exec(rest);
      if (tag) { push(tag[0], pal.key); i += tag[0].length; continue; }
    }
    const id = /^[A-Za-z_$@][\w$-]*/.exec(rest);
    if (id) {
      let w = id[0];
      if (!L.tags && !L.keys) w = /^[A-Za-z_$@][\w$]*/.exec(rest)[0];
      const after = line.slice(i + w.length);
      const look = L.nocase ? w.toLowerCase() : w;
      let c = null;
      if (kw.has(look)) c = pal.keyword;
      else if (CONSTANTS.has(w)) c = pal.constant;
      else if (L.keys && /^\s*:(?!:)/.test(after)) c = pal.key;
      else if (L.tags && /^\s*=/.test(after)) c = pal.type;
      else if (/^\s*\(/.test(after) || /^!\s*\(/.test(after)) c = pal.func;
      else if (/^[A-Z][a-z0-9]\w*$/.test(w) || (/^[A-Z]/.test(w) && L === LANGS.c && w.length > 1 && !/^[A-Z0-9_]+$/.test(w))) c = pal.type;
      push(w, c);
      i += w.length;
      continue;
    }
    push(line[i], null);
    i++;
  }
  return out;
}

// Where a string opened with `q` ends (after the closing quote), or -1.
function closeQuote(line, from, q) {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line.startsWith(q, i)) return i + q.length;
  }
  return -1;
}
