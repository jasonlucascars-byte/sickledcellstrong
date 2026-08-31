# Where these files come from

`SKILL.md` and `references/` are vendored, unmodified, from
[Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) v0.9.53
(commit `33362d9`), Apache License 2.0 — Copyright 2026 Safi Shamsi and the
Graphify contributors. See the upstream `LICENSE` and `NOTICE`.

They were written here by the project's own installer, not by hand:

```bash
uv tool install graphifyy        # or: pipx install graphifyy
graphify install --project --platform claude
```

Re-run that to upgrade; it rewrites `SKILL.md` and `references/`, keeps a
`.bak` of anything it replaces, and leaves this file alone.
`.graphify_version` is the stamp the installer compares against.

`.claude/settings.json` holds the installer's PreToolUse hooks, which nudge
toward `graphify query` instead of grep — with one deliberate change from what
the installer writes. Each command is wrapped:

```
command -v graphify >/dev/null 2>&1 && graphify hook-guard <kind> || true
```

The installer's version calls `graphify` unconditionally, and this file is
committed, so on a clone without the CLI every Bash, Grep, Read, and Glob call
printed `graphify: command not found`. The guard makes that case a silent
exit 0. With the CLI on PATH the guard runs exactly as before — it fails open
on its own and stays quiet until `graphify-out/graph.json` exists.

Re-running the installer overwrites this file and drops the guard. Put it back.
