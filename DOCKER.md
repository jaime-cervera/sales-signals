# Running Sales-Signals in Docker

Use this when the host can't install Playwright/Chromium directly (e.g. Ubuntu
26.04, NixOS without the `playwright-driver` shell, locked-down corporate
laptops). The image is based on Microsoft's official Playwright image, which
ships Chromium preinstalled and works on any Linux kernel Docker supports.

No feature is dropped: scanner, liveness checker, dashboard (Go), batch workers —
everything runs inside the container. Your project directory is bind-mounted, so
ICP data, the CRM tracker, reports, and all generated artifacts live on the host.

## Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version`)
- ~2 GB free disk for the image

## First-time setup

```bash
# from project root
./cops up           # builds image (first run takes a few minutes) and starts container
./cops doctor       # confirms node + playwright + chromium + go are present
```

That's it. Container stays running in the background. Re-runs are instant.

## Daily use

The `./cops` wrapper forwards any command into the container. Set `CAREER_OPS_ICP`
on the host to scope a run to one ICP (the wrapper forwards it):

| Task | Command |
|------|---------|
| Health check | `./cops doctor` |
| Verify CRM | `./cops verify` |
| Scan for signals | `CAREER_OPS_ICP=acme ./cops scan` |
| Check liveness | `./cops liveness <url>` |
| Merge tracker | `./cops merge` |
| Dedup tracker | `./cops dedup` |
| Normalize statuses | `./cops normalize` |
| Interactive shell | `./cops shell` |
| Raw node script | `./cops node bin/signals.mjs scan --icp acme` |
| Build dashboard | `./cops bash -c 'cd dashboard && go build -buildvcs=false -o signals-dashboard . && ./signals-dashboard --path ..'` |

Unknown subcommands fall through to `docker compose exec` so anything works:

```bash
./cops npm test
./cops bash -c 'find icps -name "*.md" | wc -l'
```

## Lifecycle

```bash
./cops up        # start (idempotent)
./cops down      # stop and remove the container (volumes kept)
./cops rebuild   # full rebuild (use after Dockerfile or deps change)
./cops logs      # tail container logs
```

## How it works

- `Dockerfile` — installs Node, Playwright/Chromium (preinstalled in base image),
  Go (for the dashboard), and project deps.
- `docker-compose.yml` — bind-mounts the project at `/app` so host edits appear
  inside the container immediately. `node_modules` lives in a named volume to
  avoid host/container ABI mismatches.
- `.dockerignore` — keeps generated and personal data out of the build context.

## API keys

Drop your keys in `.env` at the project root or export them in the shell that
runs `./cops`. The compose file forwards `UNIPILE_API_KEY`, `UNIPILE_DSN`,
`UNIPILE_ACCOUNT_ID`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` into the
container.

```bash
echo "UNIPILE_API_KEY=..." >> .env
```

## Data persistence

Everything under the project root is on your host filesystem:

- `config/vendor.yml`, `.env`
- `icps/<slug>/` — each ICP's `icp.md`, `signals.yml`, `prospects.md`, `pipeline.md`, reports

Nothing important is stored inside the container. `./cops down` is safe.

## Troubleshooting

**`docker: not found`** — install Docker Engine + Compose plugin first.

**Playwright still complains** — you're running the host's Node, not the
container's. Always go through `./cops`.

**Permission errors on generated files** — the container runs as root by
default. If host files end up root-owned, either:
- run `sudo chown -R "$USER" .` once, or
- add `user: "${UID}:${GID}"` to `docker-compose.yml` (export `UID`/`GID`
  in your shell first).

**Slow first build** — base image is ~1.5 GB. Subsequent builds reuse layers
and finish in seconds.
