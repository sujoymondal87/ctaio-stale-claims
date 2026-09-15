---
title: Aider vs Claude Code on a 10-year-old PHP codebase
published: 2026-08-20
tested_with:
  aider: 0.86.1
  claude-code: 2.1.200
  cursor: 1.7
---

Setup for the Aider half of the comparison:

```bash
pip install aider-chat==0.84.0
```

Both agents got the same task: extract a service class from a 1,400-line controller...
