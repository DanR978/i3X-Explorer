---
name: project-web-deployment
description: Live web deployment of i3X Explorer and how it works
metadata:
  type: project
---

The app is deployed as a web build at https://explorer.i3x.dev.

**Why:** Lets users try i3X Explorer in a browser without installing the desktop app.

**How to apply:** When touching web build config, asset paths, or deploy scripts, keep this deployment in mind. Changes land on the server after a `git pull` + `./scripts/deploy-web.sh` (or `sudo systemctl restart i3x-explorer-web`).

Server setup:
- Repo cloned at `/home/cesmii/repos/i3X-Explorer` (user: `cesmii`)
- nginx serves `dist-web/` on port 8090 (proxied from 443 externally)
- systemd service `i3x-explorer-web` runs `deploy-web.sh` on start: `git pull` → `npm ci` → `npm run build:web` → nginx reload
- Server-local config overrides go in `config.local.json` at repo root (git-ignored); deploy script copies it to `dist-web/config.json` after each build
