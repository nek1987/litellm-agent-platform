# E2B sandbox template

The agent sandboxes (E2B `provision`/`execute` tools) run on an E2B template.
This is its source so it lives in version control instead of only on someone's
laptop.

`E2B_TEMPLATE` (see `src/server/env.ts`) selects which template the platform
uses when it spins up a sandbox.

## What's in it
- Base: `e2bdev/code-interpreter` (Python + Node + Jupyter).
- `git` installed.
- **Pre-cloned repos** so a fresh sandbox already has them (no per-session clone):
  - `https://github.com/BerriAI/litellm` → `/home/user/litellm`
  - `https://github.com/BerriAI/litellm-docs` → `/home/user/litellm-docs`

Both repos are public, so no token is baked into the image.

## Build / update
Requires E2B CLI auth (`e2b auth login`) for the team that owns the template.

```bash
cd e2b
e2b template build --name litellm-4gb --cpu-count 8 --memory-mb 4096
```

`--cpu-count 8 --memory-mb 4096` matches the 4 GB spec. After it builds, set
`E2B_TEMPLATE` (and `E2B_API_KEY` for the owning team) on the platform service.

To refresh the pinned repo contents, rebuild with `--no-cache`.
```
