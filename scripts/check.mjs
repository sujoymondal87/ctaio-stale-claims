#!/usr/bin/env node
// Stale-claim checker for ctaio.dev posts.
// Reads posts/*.md, collects version claims, checks them against npm/PyPI,
// and writes public/index.html + public/report.json.
// Zero dependencies: Node 18+ (global fetch).
//
//   node scripts/check.mjs           build report, never fail (deploys must not
//                                    depend on registry uptime)
//   node scripts/check.mjs --strict  exit 1 if any claim is stale (for CI)

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const POSTS_DIR = path.join(ROOT, "posts");
const OUT_DIR = path.join(ROOT, "public");
const STRICT = process.argv.includes("--strict");

const tools = JSON.parse(await readFile(path.join(ROOT, "tools.json"), "utf8"));
// Reverse index so pinned install commands in the body map back to a tool.
const byPackage = new Map(
  Object.entries(tools)
    .filter(([, t]) => t.registry)
    .map(([id, t]) => [`${t.registry}:${t.package}`, id])
);

// ---------- parsing ----------

// Deliberately tiny frontmatter parser: top-level `key: value` plus one
// level of indented children (enough for `tested_with:`). Not general YAML.
function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: src, bodyStartLine: 1 };
  const data = {};
  let parent = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const child = raw.match(/^\s+([\w.@/-]+):\s*(.+)$/);
    const top = raw.match(/^([\w-]+):\s*(.*)$/);
    const clean = (v) => v.trim().replace(/^["']|["']$/g, "");
    if (child && parent) data[parent][child[1]] = clean(child[2]);
    else if (top) {
      if (top[2] === "") { parent = top[1]; data[parent] = {}; }
      else { parent = null; data[top[1]] = clean(top[2]); }
    }
  }
  const bodyStartLine = m[0].split("\n").length;
  return { data, body: src.slice(m[0].length), bodyStartLine };
}

// Only pinned install commands count as body claims: readers copy-paste them,
// so a stale pin is an actual broken instruction. Prose like "Claude Code 1.x"
// is ignored on purpose (too many false positives).
function findPins(body, startLine) {
  const pins = [];
  body.split(/\r?\n/).forEach((line, i) => {
    const lineNo = startLine + i;
    if (/\b(npm|npx|pnpm|yarn|bun)\b/.test(line)) {
      for (const m of line.matchAll(/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+(?:\.\d+)?)/gi))
        pins.push({ registry: "npm", package: m[1], declared: m[2], line: lineNo });
    }
    if (/\b(pip3?|uv|pipx|poetry)\b/.test(line)) {
      for (const m of line.matchAll(/([A-Za-z0-9._-]+)==(\d+\.\d+(?:\.\d+)?)/g))
        pins.push({ registry: "pypi", package: m[1].toLowerCase(), declared: m[2], line: lineNo });
    }
  });
  return pins;
}

// ---------- registries ----------

async function latestVersion(registry, pkg) {
  const url = registry === "npm"
    ? `https://registry.npmjs.org/${pkg}/latest`
    : `https://pypi.org/pypi/${pkg}/json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    return { version: registry === "npm" ? json.version : json.info.version };
  } catch (e) {
    return { error: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

// ---------- classification ----------

const parse = (v) => {
  const m = String(v).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [m[1], m[2] ?? 0, m[3] ?? 0].map(Number) : null;
};

// stale    = a breaking release since the claim (major bump; for 0.x, minor bump,
//            since semver allows breaking changes in 0.minor)
// drifting = same breaking line, but new minor features the post doesn't cover
// fresh    = patch-level difference or exact match
function classify(declared, latest) {
  const d = parse(declared), l = parse(latest);
  if (!d || !l) return "unknown";
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (cmp(d, l) > 0) return "ahead"; // claim newer than registry: typo or prerelease
  if (d[0] !== l[0]) return "stale";
  if (d[0] === 0) return d[1] !== l[1] ? "stale" : "fresh";
  return d[1] !== l[1] ? "drifting" : "fresh";
}

// ---------- main ----------

const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".md")).sort();
const posts = [];
for (const file of files) {
  const src = await readFile(path.join(POSTS_DIR, file), "utf8");
  const { data, body, bodyStartLine } = parseFrontmatter(src);
  const claims = [];
  for (const [id, declared] of Object.entries(data.tested_with ?? {})) {
    claims.push({ toolId: id, declared, where: "tested_with" });
  }
  for (const pin of findPins(body, bodyStartLine)) {
    const id = byPackage.get(`${pin.registry}:${pin.package}`);
    if (id) claims.push({ toolId: id, declared: pin.declared, where: `line ${pin.line}` });
  }
  posts.push({ file, title: data.title ?? file, published: data.published ?? null, claims });
}

// One request per package, however many posts mention it.
const needed = new Set(
  posts.flatMap((p) => p.claims).map((c) => tools[c.toolId]).filter((t) => t?.registry)
    .map((t) => `${t.registry}:${t.package}`)
);
const latest = new Map(
  await Promise.all([...needed].map(async (key) => {
    const [registry, ...rest] = key.split(":");
    return [key, await latestVersion(registry, rest.join(":"))];
  }))
);

for (const post of posts) {
  for (const c of post.claims) {
    const tool = tools[c.toolId];
    c.tool = tool?.name ?? c.toolId;
    if (!tool) { c.status = "unverifiable"; c.note = "Tool not in tools.json"; continue; }
    if (!tool.registry) { c.status = "unverifiable"; c.note = tool.note; continue; }
    c.package = tool.package;
    c.registry = tool.registry;
    const r = latest.get(`${tool.registry}:${tool.package}`);
    if (r.error) { c.status = "unknown"; c.note = `Registry lookup failed (${r.error})`; continue; }
    c.latest = r.version;
    c.status = classify(c.declared, r.version);
  }
}

// A pinned install command that disagrees with the post's own tested_with
// is an editorial bug even if both versions are otherwise fine.
for (const post of posts) {
  for (const c of post.claims) {
    if (c.where === "tested_with") continue;
    const fm = post.claims.find((x) => x.where === "tested_with" && x.toolId === c.toolId);
    if (fm && fm.declared !== c.declared)
      c.note = `Contradicts the post's frontmatter (${fm.declared}).` + (c.note ? " " + c.note : "");
  }
}

const RANK = { stale: 0, ahead: 1, drifting: 2, unknown: 3, unverifiable: 4, fresh: 5 };
for (const p of posts) {
  p.claims.sort((a, b) => RANK[a.status] - RANK[b.status]);
  p.worst = p.claims[0]?.status ?? "fresh";
}
posts.sort((a, b) => RANK[a.worst] - RANK[b.worst]);

const all = posts.flatMap((p) => p.claims);
const count = (s) => all.filter((c) => c.status === s).length;
const report = {
  generatedAt: new Date().toISOString(),
  totals: Object.fromEntries(Object.keys(RANK).map((s) => [s, count(s)])),
  posts,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(OUT_DIR, "index.html"), render(report));

for (const p of posts) {
  console.log(`\n${p.file}`);
  for (const c of p.claims)
    console.log(`  ${c.status.padEnd(12)} ${c.tool.padEnd(28)} ${c.declared} -> ${c.latest ?? "-"} (${c.where})`);
}
console.log(`\nWrote public/index.html and public/report.json`);
if (STRICT && count("stale") > 0) {
  console.error(`${count("stale")} stale claim(s).`);
  process.exit(1);
}

// ---------- rendering ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// Mark the version segments that moved, so an editor sees at a glance
// whether it's a major, minor, or patch change.
function diffVersion(declared, latest) {
  const d = String(declared).split("."), l = String(latest).split(".");
  let changed = false;
  return l.map((part, i) => {
    if (!changed && part !== d[i]) changed = true;
    return changed ? `<mark>${esc(part)}</mark>` : esc(part);
  }).join(".");
}

function render({ generatedAt, totals, posts }) {
  const LABEL = {
    stale: "Stale", drifting: "Drifting", fresh: "Current",
    unverifiable: "Can't verify", unknown: "Lookup failed", ahead: "Newer than registry",
  };
  const EXPLAIN = {
    stale: "A breaking release has shipped since this was written.",
    drifting: "New features shipped that the post doesn't cover.",
    fresh: "Only patch releases since.",
    ahead: "Claimed version isn't published. Check for a typo.",
  };
  const staleCount = totals.stale;
  const postsAffected = posts.filter((p) => p.worst === "stale").length;
  const headline = staleCount === 0
    ? `Every checked version claim in ${posts.length} posts is still current.`
    : `${postsAffected} of ${posts.length} posts tell readers to use a version that has since had a breaking release.`;

  const rows = (p) => p.claims.map((c) => `
      <tr class="s-${c.status}">
        <td class="tool">${esc(c.tool)}${c.package ? `<code>${esc(c.package)}</code>` : ""}</td>
        <td class="where">${esc(c.where === "tested_with" ? "Frontmatter" : `Install command, ${c.where}`)}</td>
        <td class="ver"><code>${esc(c.declared)}</code></td>
        <td class="ver">${c.latest ? `<code>${diffVersion(c.declared, c.latest)}</code>` : "&ndash;"}</td>
        <td class="status"><strong>${LABEL[c.status]}</strong><span>${esc(c.note ?? EXPLAIN[c.status] ?? "")}</span></td>
      </tr>`).join("");

  const sections = posts.map((p) => `
    <section class="post w-${p.worst}">
      <h2>${esc(p.title)}</h2>
      <p class="meta">posts/${esc(p.file)}${p.published ? `, published ${esc(p.published)}` : ""}</p>
      ${p.claims.length ? `<div class="scroll"><table>
        <thead><tr><th>Tool</th><th>Where</th><th>Post says</th><th>Latest</th><th>Status</th></tr></thead>
        <tbody>${rows(p)}</tbody></table></div>` : `<p class="empty">No version claims. Add <code>tested_with:</code> to the frontmatter to track this post.</p>`}
    </section>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Version claims check | ctaio.dev</title>
<meta name="description" content="Which ctaio.dev posts cite tool versions that have moved on.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #F6F7F9; --ink: #1F2533; --muted: #5E6778; --rule: #D8DCE3;
    --stale: #B42318; --drift: #8A5300; --fresh: #2F6B3E; --flat: #5E6778;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
    font: 16px/1.55 "IBM Plex Sans", system-ui, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 56px 24px 80px; }
  .kicker { color: var(--muted); margin: 0 0 12px; }
  h1 { font-size: clamp(28px, 4.2vw, 42px); line-height: 1.15; font-weight: 600;
    max-width: 22ch; margin: 0 0 20px; letter-spacing: -0.01em; }
  .lede { max-width: 64ch; color: var(--muted); margin: 0 0 12px; }
  .tally { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 28px 0 48px; padding: 0; list-style: none; }
  .tally li { font-variant-numeric: tabular-nums; }
  .tally b { font-weight: 600; }
  .post { border-left: 4px solid var(--rule); padding: 4px 0 4px 20px; margin: 0 0 44px; }
  .post.w-stale { border-color: var(--stale); }
  .post.w-drifting, .post.w-ahead { border-color: var(--drift); }
  .post.w-fresh { border-color: var(--fresh); }
  h2 { font-size: 21px; line-height: 1.3; margin: 0 0 4px; font-weight: 600; }
  .meta { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; min-width: 640px; }
  th { text-align: left; font-weight: 600; font-size: 13px; color: var(--muted);
    border-bottom: 1px solid var(--rule); padding: 6px 12px 6px 0; }
  td { vertical-align: top; border-bottom: 1px solid var(--rule); padding: 10px 12px 10px 0; }
  code { font: 14px/1.4 "IBM Plex Mono", ui-monospace, monospace; }
  .tool code { display: block; color: var(--muted); font-size: 12.5px; }
  .ver { white-space: nowrap; font-variant-numeric: tabular-nums; }
  mark { background: none; color: inherit; font-weight: 600; text-decoration: underline 2px; text-underline-offset: 3px; }
  .status strong { display: block; font-weight: 600; }
  .status span { display: block; color: var(--muted); font-size: 13.5px; max-width: 30ch; }
  .s-stale .status strong, .s-stale mark { color: var(--stale); }
  .s-drifting .status strong, .s-drifting mark, .s-ahead .status strong { color: var(--drift); }
  .s-fresh .status strong { color: var(--fresh); }
  .s-unverifiable .status strong, .s-unknown .status strong { color: var(--flat); }
  .empty { color: var(--muted); }
  footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 14px; max-width: 70ch; }
  a { color: var(--ink); }
  a:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <p class="kicker">ctaio.dev editorial check, run ${esc(new Date(generatedAt).toUTCString())}</p>
  <h1>${esc(headline)}</h1>
  <p class="lede">Each post declares the tool versions it was tested with, and pinned install commands are read from the body. Every claim is checked against npm and PyPI at build time.</p>
  <ul class="tally">
    <li><b>${totals.stale}</b> stale</li>
    <li><b>${totals.drifting}</b> drifting</li>
    <li><b>${totals.fresh}</b> current</li>
    <li><b>${totals.unverifiable + totals.unknown + totals.ahead}</b> need a manual check</li>
  </ul>
  ${sections}
  <footer>
    Stale means a breaking release since the claim: a major bump, or a minor bump for 0.x packages, since semver allows breaking changes there.
    Tools without a public registry, such as Cursor, are listed but not guessed.
    Raw data: <a href="report.json">report.json</a>.
  </footer>
</main>
</body>
</html>`;
}
