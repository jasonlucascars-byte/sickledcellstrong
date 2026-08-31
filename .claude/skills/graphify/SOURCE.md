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

The installer also offers a `.claude/settings.json` PreToolUse hook that nudges
toward `graphify query` instead of grep. It is deliberately **not** committed
here: the hook shells out to `graphify` unconditionally, so on any machine
without the CLI installed it prints `graphify: command not found` on every
Bash, Grep, Read, and Glob call. Run the installer locally if you want it.
