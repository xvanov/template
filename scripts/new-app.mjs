#!/usr/bin/env node
/**
 * Start a new app from this template with only the modules it needs.
 *
 *   node scripts/new-app.mjs <target-dir> [--profile web] [--with a,b] [--without c]
 *                            [--name "My App"] [--scheme myapp] [--bundle-id com.me.myapp]
 *                            [--port-base 3400] [--no-install] [--no-git]
 *   node scripts/new-app.mjs --list
 *
 * What it does, in order:
 *   1. resolves the module set: the profile, plus --with, minus --without, plus
 *      every dependency of what is left (template/modules.json)
 *   2. copies the files git tracks (committed or staged, as they are on
 *      disk; no untracked files, no .git, no node_modules) into a temporary
 *      directory next to the target, which must be empty or absent
 *   3. deletes the paths owned by each module that was not selected
 *   4. cuts every marker block for a missing module out of every text file
 *      (syntax below) and strips the markers of the kept ones
 *   5. drops what JSON cannot mark: @repo/* deps on deleted packages, the
 *      modules' npm deps and root scripts, their turbo globalEnv keys
 *   6. renames (name, scheme, bundle id, desktop identifier), writes the new
 *      app's CLAUDE.md / README.md / .template.json
 *   7. --port-base: shifts every default port by the same offset
 *   8. checks nothing of a removed module is left (its `leftovers` patterns)
 *   9. npm install, prettier, git init + first commit, then moves the
 *      directory into place (a failure leaves nothing behind)
 *
 * Marker syntax (any comment style: //  #  --  <!-- -->  {/* *\/}  /* *\/):
 *   a line that is ONLY `// @module:sms` opens a block, `// @end` closes it
 *   code followed by `// @module:sms` at the END of the line = that line only
 *   expression: `a,b` = all of them, `a|b` = any, `!a` = only WITHOUT a;
 *   `template` = the template's own machinery, cut from every app
 *   `// @end:<expr>` may name its block, and must then match the opener
 *   in ignore files and .env files only whole-line comments are markers
 *
 * No dependencies: plain Node >= 22, so it runs before `npm install`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, "template/modules.json"), "utf8"),
);

// ── markers ──────────────────────────────────────────────────────────────
const OPEN = String.raw`(?:\/\/|#|--|<!--|\{\/\*|\/\*)`;
const CLOSE = String.raw`(?:-->|\*\/\}|\*\/)?`;
const EXPR = String.raw`([!A-Za-z0-9_,|-]+)`;
const BLOCK_START = new RegExp(
  String.raw`^\s*${OPEN}\s*@module:${EXPR}\s*${CLOSE}\s*$`,
);
const BLOCK_END = new RegExp(
  String.raw`^\s*${OPEN}\s*@end(?::${EXPR})?\s*${CLOSE}\s*$`,
);
const INLINE = new RegExp(
  String.raw`\s*${OPEN}\s*@module:${EXPR}\s*${CLOSE}\s*$`,
);
const ANY_MARKER = /@module:|@end\b/;

/** `a,b|!c` → true when (a and b) or (not c). Unknown ids are an error. */
export function evalExpr(expr, selected, where) {
  return expr.split("|").some((group) =>
    group.split(",").every((term) => {
      const neg = term.startsWith("!");
      const id = neg ? term.slice(1) : term;
      // `template`: the template's own machinery, cut from every app.
      if (id === "template") return neg;
      if (!MANIFEST.modules[id])
        throw new Error(`${where}: unknown module "${id}" in @module:${expr}`);
      return neg ? !selected.has(id) : selected.has(id);
    }),
  );
}

/**
 * Files where `#` starts a comment only at the beginning of a line: an
 * end-of-line marker there would become part of the pattern or value.
 */
function lineCommentsOnly(where) {
  const base = path.basename(where);
  if (/^\.[a-z]*ignore$/.test(base)) return "ignore";
  if (/^\.env/.test(base)) return "env";
  return null;
}

/**
 * Apply markers to one file's text. Returns { text, changed } or throws on
 * anything malformed: an unbalanced block, an `@end:<label>` that does not
 * match its opener, an unknown module id, a marker the parser does not
 * recognise, or an end-of-line marker where `#` is not a comment.
 */
export function applyMarkers(text, selected, where) {
  if (!ANY_MARKER.test(text)) return { text, changed: false };
  const out = [];
  const stack = []; // { keep, line, expr }
  const kind = lineCommentsOnly(where);
  text.split("\n").forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    const start = line.match(BLOCK_START);
    if (start) {
      const keep = evalExpr(start[1], selected, at);
      stack.push({ keep, line: i + 1, expr: start[1] });
      return;
    }
    const end = line.match(BLOCK_END);
    if (end) {
      if (!stack.length)
        throw new Error(`${at}: @end without an open @module block`);
      const open = stack.pop();
      if (end[1] && end[1] !== open.expr)
        throw new Error(
          `${at}: @end:${end[1]} closes @module:${open.expr} (line ${open.line})`,
        );
      return;
    }
    const inline = line.match(INLINE);
    const isInline = inline && line.slice(0, inline.index).trim();
    if (isInline) {
      if (kind === "ignore" || (kind === "env" && !/^\s*#/.test(line)))
        throw new Error(
          `${at}: an end-of-line marker is not a comment in this file; use a block (# @module:<id> … # @end)`,
        );
      evalExpr(inline[1], selected, at); // unknown ids fail even in cut blocks
    } else if (line.includes("@module:")) {
      throw new Error(`${at}: unrecognised @module marker: ${line.trim()}`);
    }
    if (!stack.every((s) => s.keep)) return;
    if (isInline) {
      if (!evalExpr(inline[1], selected, at)) return;
      out.push(line.slice(0, inline.index).trimEnd());
      return;
    }
    out.push(line);
  });
  if (stack.length)
    throw new Error(
      `${where}:${stack.at(-1).line}: @module block never closed`,
    );
  const result = out.join("\n");
  return { text: result, changed: result !== text };
}

/**
 * Remove the statements of a Prisma migration that name any of `tables`
 * (CREATE/ALTER TABLE, CREATE INDEX ... ON, a foreign key REFERENCES), with
 * the comments and blank lines in front of each. Statements are split at
 * `;` outside strings, quoted names and comments, so a `;` in a comment or
 * two statements on one line are handled. A dollar-quoted body (`$$ ... $$`)
 * in a migration that touches a removed table is refused, not guessed at.
 */
export function pruneMigration(text, tables, where) {
  if (!tables.length) return text;
  const named = (sql) => tables.some((t) => sql.includes(`"${t}"`));
  if (!named(text)) return text;
  if (/\$[A-Za-z_]*\$/.test(text))
    throw new Error(
      `${where}: cannot split a dollar-quoted body; give the module its own migration`,
    );
  const chunks = []; // { text, sql }: sql = the chunk without comments
  let start = 0;
  let sql = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = (nl < 0 ? text.length : nl) - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) throw new Error(`${where}: unclosed /* comment`);
      i = close + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === c && text[j + 1] === c) j++;
        else if (text[j] === c) break;
      }
      if (j >= text.length) throw new Error(`${where}: unclosed ${c} quote`);
      sql += text.slice(i, j + 1);
      i = j;
      continue;
    }
    sql += c;
    if (c === ";") {
      // The rest of the line (spaces, a trailing comment) goes with it.
      const rest = /^[ \t]*(--[^\n]*)?\n?/.exec(text.slice(i + 1))[0];
      const end = i + 1 + rest.length;
      chunks.push({ text: text.slice(start, end), sql });
      start = end;
      i = end - 1;
      sql = "";
    }
  }
  if (named(sql))
    throw new Error(
      `${where}: a statement without a closing ";" names a removed table`,
    );
  chunks.push({ text: text.slice(start), sql: "" });
  return chunks
    .filter((c) => !named(c.sql))
    .map((c) => c.text)
    .join("");
}

// ── module selection ─────────────────────────────────────────────────────
function closure(ids) {
  const out = new Set(["core"]);
  const add = (id) => {
    const m = MANIFEST.modules[id];
    if (!m) throw new Error(`unknown module "${id}" (see --list)`);
    if (out.has(id) && id !== "core") return;
    out.add(id);
    for (const d of m.requires ?? []) add(d);
  };
  for (const id of ids) add(id);
  return out;
}

export function resolveModules({
  profile = "web",
  withIds = [],
  withoutIds = [],
}) {
  const p = MANIFEST.profiles[profile];
  if (!p) throw new Error(`unknown profile "${profile}" (see --list)`);
  const wanted = new Set([...p.modules, ...withIds]);
  for (const id of withoutIds) {
    if (id === "core") throw new Error("core cannot be removed");
    if (!MANIFEST.modules[id]) throw new Error(`unknown module "${id}"`);
    wanted.delete(id);
  }
  let selected = closure(wanted);
  // --without wins over dependencies: drop whatever needs a removed module.
  const dropped = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const id of selected) {
      const needs = MANIFEST.modules[id].requires ?? [];
      const missing = needs.filter(
        (d) => withoutIds.includes(d) || !selected.has(d),
      );
      if (id !== "core" && (withoutIds.includes(id) || missing.length)) {
        selected.delete(id);
        if (!withoutIds.includes(id))
          dropped.push(`${id} (needs ${missing.join(", ")})`);
        changed = true;
      }
    }
  }
  return { selected, dropped };
}

// ── files ────────────────────────────────────────────────────────────────
/** Files git tracks (committed or staged), read from the working tree. */
function templateFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  }).toString();
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(ROOT, f))); // deleted but not staged
}

const matches = (file, p) =>
  p.endsWith("/") ? file.startsWith(p) : file === p || file.startsWith(p + "/");

function isText(buf) {
  return !buf.subarray(0, 8192).includes(0);
}

// ── rename ───────────────────────────────────────────────────────────────
function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

function renames(opts) {
  const name = opts.name;
  const slug = slugify(name);
  const scheme = opts.scheme ?? slug.replace(/-/g, "");
  const bundleId = opts.bundleId ?? `com.example.${scheme}`;
  // A home-screen label: the name if short, else its first word (12 chars max).
  const shortName = (name.length <= 12 ? name : name.split(/\s+/)[0]).slice(
    0,
    12,
  );
  return { name, shortName, slug, scheme, bundleId };
}

/** [file, from, to] — every one must apply, so a template edit cannot silently skip a rename. */
function renameEdits(r) {
  return [
    [
      ".env.example",
      "APP_SCHEME=apptemplate",
      `APP_SCHEME=${r.scheme}`,
      "mobile",
    ],
    [
      ".env.example",
      'SMTP_FROM="App Template <no-reply@localhost>"',
      `SMTP_FROM="${r.name} <no-reply@localhost>"`,
    ],
    [
      ".env.example",
      "MOBILE_APP_NAME=\n",
      `MOBILE_APP_NAME=${r.name}\n`,
      "mobile",
    ],
    [
      ".env.example",
      "MOBILE_APP_SLUG=\n",
      `MOBILE_APP_SLUG=${r.slug}\n`,
      "mobile",
    ],
    [
      ".env.example",
      "MOBILE_BUNDLE_ID=\n",
      `MOBILE_BUNDLE_ID=${r.bundleId}\n`,
      "mobile",
    ],
    [
      "packages/env/src/index.ts",
      'APP_SCHEME: z.string().default("apptemplate")',
      `APP_SCHEME: z.string().default("${r.scheme}")`,
      "mobile",
    ],
    [
      "packages/env/src/index.ts",
      'default("App Template <no-reply@localhost>")',
      `default("${r.name} <no-reply@localhost>")`,
    ],
    [
      "apps/web/src/app/layout.tsx",
      'default: "App Template", template: "%s · App Template"',
      `default: ${JSON.stringify(r.name)}, template: ${JSON.stringify(`%s · ${r.name}`)}`,
    ],
    [
      "apps/web/src/app/layout.tsx",
      'description: "Web + mobile app template — Next.js, Expo, tRPC, Prisma."',
      `description: ${JSON.stringify(r.name)}`,
    ],
    [
      "apps/web/src/app/manifest.ts",
      'description: "Web + mobile app template — Next.js, Expo, tRPC, Prisma."',
      `description: ${JSON.stringify(r.name)}`,
    ],
    [
      "apps/web/src/app/manifest.ts",
      'short_name: "App"',
      `short_name: ${JSON.stringify(r.shortName)}`,
    ],
    [
      "apps/web/src/app/manifest.ts",
      'name: "App Template"',
      `name: ${JSON.stringify(r.name)}`,
    ],
    ["apps/web/src/app/page.tsx", "App template", r.name],
    [
      "packages/email/src/index.ts",
      'appName = "App Template"',
      `appName = ${JSON.stringify(r.name)}`,
    ],
    [
      "packages/auth/src/index.ts",
      'appName: "app-template"',
      `appName: ${JSON.stringify(r.slug)}`,
    ],
    [
      "apps/mobile/app.config.ts",
      '"MOBILE_APP_NAME", "App Template"',
      `"MOBILE_APP_NAME", ${JSON.stringify(r.name)}`,
      "mobile",
    ],
    [
      "apps/mobile/app.config.ts",
      '"MOBILE_APP_SLUG", "app-template"',
      `"MOBILE_APP_SLUG", "${r.slug}"`,
      "mobile",
    ],
    [
      "apps/mobile/app.config.ts",
      '"MOBILE_BUNDLE_ID", "com.example.apptemplate"',
      `"MOBILE_BUNDLE_ID", "${r.bundleId}"`,
      "mobile",
    ],
    [
      "apps/mobile/app.config.ts",
      '"APP_SCHEME", "apptemplate"',
      `"APP_SCHEME", "${r.scheme}"`,
      "mobile",
    ],
    [
      "apps/mobile/lib/auth.ts",
      '?? "apptemplate"',
      `?? "${r.scheme}"`,
      "mobile",
    ],
    [
      "apps/desktop/src-tauri/tauri.conf.json",
      '"productName": "App Template"',
      `"productName": ${JSON.stringify(r.name)}`,
      "desktop",
    ],
    [
      "apps/desktop/src-tauri/tauri.conf.json",
      '"mainBinaryName": "app-template"',
      `"mainBinaryName": "${r.slug}"`,
      "desktop",
    ],
    [
      "apps/desktop/src-tauri/tauri.conf.json",
      '"identifier": "com.example.apptemplate"',
      `"identifier": "${r.bundleId}"`,
      "desktop",
    ],
  ];
}

// ── ports ────────────────────────────────────────────────────────────────
/** The template's default ports (web first), as written in its files. */
const PORTS = [3200, 5442, 6389, 1035, 8035, 1036, 8036, 8091, 8092];
/** Files whose numbers are test data or fixtures, not configuration. */
const PORTS_SKIP = ["packages/evals/", "packages/rag/"];

/**
 * `--port-base 3400`: web on 3400 and every other default port (Postgres,
 * Redis, the mail catchers, Expo) and the smoke gate's port ranges shifted
 * by the same +200, in every text file (.env.example, compose, Makefile,
 * scripts, code defaults, docs), so two generated apps run side by side.
 */
function shiftPorts(target, files, base) {
  if (base === undefined) return null;
  const offset = base - PORTS[0];
  if (
    !Number.isInteger(base) ||
    PORTS.some((p) => p + offset < 1024 || p + offset > 65000)
  )
    throw new Error(
      `--port-base ${base}: every port must stay within 1024-65000`,
    );
  if (offset === 0) return { web: base };
  const re = new RegExp(
    String.raw`(?<![\d.])(${PORTS.join("|")})(?![\d])`,
    "g",
  );
  for (const f of files) {
    if (
      PORTS_SKIP.some((p) => matches(f, p)) ||
      LOCKFILES.has(path.basename(f))
    )
      continue;
    const p = path.join(target, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    if (!isText(buf)) continue;
    let text = buf.toString("utf8");
    const before = text;
    text = text.replace(re, (n) => String(Number(n) + offset));
    // The smoke gate picks free ports in fixed ranges: `pick_port <base> <span>`.
    if (f === "scripts/smoke.sh")
      text = text.replace(
        /pick_port (\d+) (\d+)\)/g,
        (_, b, span) => `pick_port ${Number(b) + offset} ${span})`,
      );
    if (text !== before) fs.writeFileSync(p, text);
  }
  return Object.fromEntries(PORTS.map((p) => [p, p + offset]));
}

// ── main ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { withIds: [], withoutIds: [], install: true, git: true };
  const list = (v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--list" || a === "-l") opts.list = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--profile" || a === "-p") opts.profile = val();
    else if (a === "--with") opts.withIds.push(...list(val()));
    else if (a === "--without") opts.withoutIds.push(...list(val()));
    else if (a === "--name") opts.name = val();
    else if (a === "--scheme") opts.scheme = val();
    else if (a === "--bundle-id") opts.bundleId = val();
    else if (a === "--port-base") opts.portBase = Number(val());
    else if (a === "--no-install") opts.install = false;
    else if (a === "--no-git") opts.git = false;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (!opts.target) opts.target = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return opts;
}

function printList() {
  console.log("Profiles (--profile):\n");
  for (const [id, p] of Object.entries(MANIFEST.profiles)) {
    const mods = [...closure(p.modules)].filter((m) => m !== "core");
    console.log(`  ${id.padEnd(10)} ${p.description}`);
    console.log(
      `  ${"".padEnd(10)} modules: core${mods.length ? ", " + mods.join(", ") : ""}\n`,
    );
  }
  console.log("Modules (--with / --without):\n");
  for (const [id, m] of Object.entries(MANIFEST.modules)) {
    const req = m.requires?.length ? `  [needs ${m.requires.join(", ")}]` : "";
    console.log(`  ${id.padEnd(12)} ${m.description}${req}`);
  }
}

const USAGE = `usage: scripts/new-app.sh <target-dir> [--profile <name>] [--with a,b] [--without c,d]
                          [--name "My App"] [--scheme myapp] [--bundle-id com.me.myapp]
                          [--port-base 3400]
                          [--no-install] [--no-git]
       scripts/new-app.sh --list`;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

const LOCKFILES = new Set(["package-lock.json", "Cargo.lock", "uv.lock"]);

/** Every removed module's `leftovers` patterns, searched in every kept text file. */
export function findLeftovers(target, selected, files) {
  const hits = [];
  const modules = Object.entries(MANIFEST.modules);
  modules.push(["template", { leftovers: MANIFEST.templateLeftovers }]);
  for (const [id, m] of modules) {
    // An app the module owns (apps/<name>/): turbo task ids, workspace flags.
    const apps = (m.paths ?? [])
      .map((p) => /^apps\/([^/]+)\/$/.exec(p)?.[1])
      .filter(Boolean)
      .flatMap((a) => [`"${a}#`, `-w ${a}\\b`, `--filter=${a}\\b`]);
    const patterns = [
      ...apps,
      ...(m.leftovers ?? []),
      ...(m.env ?? []).map((k) => `\\b${k}\\b`),
    ];
    if (selected.has(id) || !patterns.length) continue;
    const re = new RegExp(patterns.join("|"));
    for (const f of files) {
      if (LOCKFILES.has(path.basename(f))) continue; // regenerated by the install
      if ((MANIFEST.leftoverIgnore ?? []).some((p) => matches(f, p))) continue; // fixture prose
      const p = path.join(target, f);
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      if (!isText(buf)) continue;
      buf
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          if (re.test(line))
            hits.push(`${f}:${i + 1} [${id}] ${line.trim().slice(0, 120)}`);
        });
    }
  }
  return hits;
}

export function generate(opts) {
  const { selected, dropped } = resolveModules(opts);
  const target = path.resolve(opts.target);
  if (fs.existsSync(target) && fs.readdirSync(target).length)
    throw new Error(`${target} is not empty — pick a new directory`);
  const r = renames({ ...opts, name: opts.name ?? path.basename(target) });
  if (opts.portBase !== undefined && !Number.isInteger(opts.portBase))
    throw new Error("--port-base needs a whole number, e.g. 3400");
  const removed = Object.keys(MANIFEST.modules).filter(
    (id) => !selected.has(id),
  );

  console.log(`→ ${path.basename(target)}: ${[...selected].join(", ")}`);
  for (const d of dropped) console.log(`  (also dropped ${d})`);

  // 1. copy, minus template-only files and unselected modules' paths
  const ownedBy = (f) =>
    removed.find((id) =>
      (MANIFEST.modules[id].paths ?? []).some((p) => matches(f, p)),
    ) ??
    (MANIFEST.sharedPaths ?? []).find(
      (sp) =>
        matches(f, sp.path) && !evalExpr(sp.when, selected, "sharedPaths"),
    );
  const kept = [];
  for (const f of templateFiles()) {
    if (MANIFEST.templateOnly.some((p) => matches(f, p))) continue;
    if (ownedBy(f)) continue;
    kept.push(f);
  }

  // 2. markers
  fs.mkdirSync(target, { recursive: true });
  const written = [];
  for (const f of kept) {
    const src = path.join(ROOT, f);
    const dst = path.join(target, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const buf = fs.readFileSync(src);
    if (isText(buf)) {
      const { text } = applyMarkers(buf.toString("utf8"), selected, f);
      fs.writeFileSync(dst, text);
    } else fs.writeFileSync(dst, buf);
    fs.chmodSync(dst, fs.statSync(src).mode);
    written.push(f);
  }

  // 3. migrations: drop every statement that touches a removed module's
  // table (applied migrations are never edited in the template: Prisma
  // checksums them), then any migration left with no statements.
  const dropTables = removed.flatMap((id) => MANIFEST.modules[id].tables ?? []);
  const migDir = path.join(target, "packages/db/prisma/migrations");
  for (const d of fs.readdirSync(migDir)) {
    const sql = path.join(migDir, d, "migration.sql");
    if (!fs.existsSync(sql)) continue;
    const text = pruneMigration(
      fs.readFileSync(sql, "utf8"),
      dropTables,
      `migrations/${d}`,
    );
    const body = text
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"));
    if (!body.length) fs.rmSync(path.join(migDir, d), { recursive: true });
    else fs.writeFileSync(sql, text);
  }

  // 4. JSON: package deps + scripts, turbo globalEnv
  const exists = (p) => fs.existsSync(path.join(target, p));
  const workspaceNames = new Map(); // @repo/x → still present?
  for (const base of ["apps", "packages"]) {
    for (const d of fs.readdirSync(path.join(ROOT, base))) {
      const pj = path.join(ROOT, base, d, "package.json");
      if (!fs.existsSync(pj)) continue;
      const name = JSON.parse(fs.readFileSync(pj, "utf8")).name;
      workspaceNames.set(name, exists(`${base}/${d}/package.json`));
    }
  }
  const dropDeps = {};
  const dropScripts = {};
  for (const id of removed) {
    for (const [file, deps] of Object.entries(
      MANIFEST.modules[id].npmDeps ?? {},
    ))
      (dropDeps[file] ??= []).push(...deps);
    for (const [file, s] of Object.entries(MANIFEST.modules[id].scripts ?? {}))
      (dropScripts[file] ??= []).push(...s);
  }
  for (const f of written.filter((f) => f.endsWith("package.json"))) {
    const p = path.join(target, f);
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    let touched = false;
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(pkg[key] ?? {})) {
        if (
          workspaceNames.get(dep) === false ||
          (dropDeps[f] ?? []).includes(dep)
        ) {
          delete pkg[key][dep];
          touched = true;
        }
      }
    }
    for (const s of dropScripts[f] ?? []) {
      if (pkg.scripts?.[s] !== undefined) {
        delete pkg.scripts[s];
        touched = true;
      }
    }
    if (f === "package.json") {
      pkg.name = r.slug;
      pkg.description = r.name;
      pkg.version = "0.1.0";
      touched = true;
    }
    if (touched) fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  }
  const dropEnv = new Set(
    removed.flatMap((id) => MANIFEST.modules[id].env ?? []),
  );
  // JSON that carries env keys (eas.json build profiles): drop removed ones.
  // An object emptied this way (`"env": {}`) goes too.
  const dropKeys = (o) => {
    if (!o || typeof o !== "object") return false;
    let touched = false;
    for (const k of Object.keys(o)) {
      if (dropEnv.has(k)) {
        delete o[k];
        touched = true;
      } else if (dropKeys(o[k]) && !Object.keys(o[k]).length) delete o[k];
    }
    return touched;
  };
  for (const f of MANIFEST.envJson ?? []) {
    const p = path.join(target, f);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    dropKeys(j);
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  }
  const turboPath = path.join(target, "turbo.json");
  const turbo = JSON.parse(fs.readFileSync(turboPath, "utf8"));
  turbo.globalEnv = turbo.globalEnv.filter((k) => !dropEnv.has(k));
  for (const t of removed.flatMap(
    (id) => MANIFEST.modules[id].turboTasks ?? [],
  ))
    delete turbo.tasks[t];
  fs.writeFileSync(turboPath, JSON.stringify(turbo, null, 2) + "\n");

  // 5. rename
  for (const [file, from, to, mod] of renameEdits(r)) {
    if (mod && !selected.has(mod)) continue;
    const p = path.join(target, file);
    const text = fs.readFileSync(p, "utf8");
    if (!text.includes(from))
      throw new Error(`rename: "${from}" not found in ${file}`);
    fs.writeFileSync(p, text.split(from).join(to));
  }

  // 6. the new app's own CLAUDE.md, README.md and a record of where it came from
  const fill = (s) =>
    s
      .replaceAll("{{NAME}}", r.name)
      .replaceAll("{{PROFILE}}", opts.profile ?? "web")
      .replaceAll("{{MODULES}}", [...selected].join(", "));
  for (const [from, to] of [
    ["template/app/CLAUDE.md", "CLAUDE.md"],
    ["template/app/README.md", "README.md"],
  ]) {
    const src = fs.readFileSync(path.join(ROOT, from), "utf8");
    fs.writeFileSync(
      path.join(target, to),
      fill(applyMarkers(src, selected, from).text),
    );
    written.push(to);
  }
  // 7. ports: every default port moves by the same offset as the web port
  const ports = shiftPorts(target, written, opts.portBase);

  let commit = "unknown";
  let dirty = false;
  try {
    dirty = Boolean(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: ROOT,
      })
        .toString()
        .trim(),
    );
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
    })
      .toString()
      .trim();
  } catch {}
  fs.writeFileSync(
    path.join(target, ".template.json"),
    JSON.stringify(
      {
        template: commit,
        profile: opts.profile ?? "web",
        modules: [...selected],
        removed,
        // Generated from uncommitted template changes: `template` alone does
        // not say what this app came from.
        ...(dirty ? { dirty: true } : {}),
        ...(ports ? { ports } : {}),
      },
      null,
      2,
    ) + "\n",
  );

  // 7. nothing of a removed module may be left
  const hits = findLeftovers(target, selected, written);
  if (hits.length) {
    throw new Error(
      `references to removed modules are left in ${target}:\n  ${hits.join("\n  ")}\n` +
        "Mark them in the template (// @module:<id>) or move them into the module's paths.",
    );
  }
  return { target, selected, removed, r };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) return console.log(USAGE);
  if (opts.list) return printList();
  if (!opts.target) {
    console.error(USAGE);
    process.exit(2);
  }
  const final = path.resolve(opts.target);
  if (fs.existsSync(final) && fs.readdirSync(final).length) {
    console.error(`✗ ${final} is not empty — pick a new directory`);
    process.exit(1);
  }
  // Built next to the target and moved into place only when everything
  // (copy, checks, install, commit) worked: a failure leaves no half an app.
  const target = path.join(
    path.dirname(final),
    `.${path.basename(final)}.partial-${process.pid}`,
  );
  fs.rmSync(target, { recursive: true, force: true });
  try {
    const { selected } = generate({
      ...opts,
      target,
      name: opts.name ?? path.basename(final),
    });
    if (opts.install) {
      console.log("→ npm install");
      run("npm", ["install", "--no-audit", "--fund=false"], target);
      console.log("→ prettier");
      run("npx", ["prettier", "--write", "--log-level=warn", "."], target);
    }
    if (opts.git) {
      run("git", ["init", "-q", "-b", "main"], target);
      run("git", ["add", "-A"], target);
      // A machine with no git identity (CI) still gets its first commit.
      const who = spawnSync("git", ["config", "user.email"], { cwd: target });
      const identity = who.stdout?.toString().trim()
        ? []
        : [
            "-c",
            "user.name=App template",
            "-c",
            "user.email=template@localhost",
          ];
      run(
        "git",
        [
          ...identity,
          "commit",
          "-q",
          "-m",
          `Start from the app template (profile ${opts.profile ?? "web"})`,
        ],
        target,
      );
    }
    if (fs.existsSync(final)) fs.rmdirSync(final); // empty, checked above
    fs.renameSync(target, final);
    const rel = path.relative(process.cwd(), final) || ".";
    const web = opts.portBase ?? 3200;
    console.log(`\n✓ ${final}\n\nNext:\n  cd ${rel}`);
    if (!opts.install) console.log("  npm install");
    console.log("  ./scripts/setup.sh     # .env, postgres/redis, migrations");
    console.log(`  make dev               # → http://localhost:${web}`);
    if (selected.has("mobile"))
      console.log("  make mobile            # Expo dev server");
    console.log("  then fill in the Project section of CLAUDE.md");
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true });
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
