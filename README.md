# ctaio-stale-claims

Flags ctaio.dev posts whose tool-version claims have gone stale.

Agentic-coding tools ship weekly. A Claude Code walkthrough from three months ago
can tell readers to install a version with a different CLI. This check runs at build
time and publishes a report of which posts need an editor.

## How claims are found
1. **Declared:** `tested_with:` in post frontmatter (tool ids from `tools.json`).
2. **Pinned install commands** in the body: `npm i pkg@x.y.z`, `pip install pkg==x.y.z`.
   These are copy-pasted by readers, so a stale pin is a broken instruction.
   Prose mentions ("Claude Code 1.x") are ignored on purpose: too noisy.

## Status rules
- **Stale:** breaking release since the claim (major bump; minor bump for 0.x).
- **Drifting:** same breaking line, newer minor.
- **Current:** patch-level difference only.
- **Can't verify:** no public registry (Cursor). Listed, never guessed.
- A body pin that contradicts the post's own frontmatter is called out.

## Run
```
npm run build   # writes public/index.html + public/report.json, never fails the deploy
npm run check   # exits 1 on stale claims, for CI
```
No dependencies. Node 18+. Deployed on Vercel (`vercel.json`).
