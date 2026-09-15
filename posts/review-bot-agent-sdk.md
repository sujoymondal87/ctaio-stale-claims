---
title: A PR review bot on the Claude Agent SDK in 200 lines
published: 2026-06-02
tested_with:
  claude-agent-sdk-py: 0.2.140
  anthropic-py: 1.2.0
---

```bash
pip install claude-agent-sdk==0.2.140
```

The bot reads the diff, asks the agent for findings, and posts review comments...
