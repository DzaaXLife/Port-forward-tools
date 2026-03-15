# hostweb

A standalone Node.js CLI tool that deploys any web project locally and exposes it to the internet through a public tunnel — no configuration required.

It auto-detects your framework, installs dependencies, builds if needed, starts a server, and opens a tunnel, all with a single command.

---

## Features

- **Zero-config framework detection** — React, Vue, Svelte, Next.js, Nuxt, Astro, Angular, TypeScript, plain Node.js, Python, and static HTML
- **Two tunnel providers** — LocalTunnel (instant) or Cloudflare (stable, no password)
- **Live log streaming** — inspect stdout/stderr of any running project
- **Environment variable management** — set env vars and auto-restart in one command
- **Multiple simultaneous projects** — run and manage several projects at once

---

## Requirements

- Node.js 18 or later
- npm
- Python 3 (only if deploying Python projects)

---

## Installation

Clone or download `hostweb.js` and install dependencies:

```bash
npm install
```

---

## Quick Start

**1. Place your project files in `./web/<name>/`:**

```
./web/
  myapp/
    index.html
    ...
```

**2. Deploy it:**

```bash
# Using LocalTunnel (tunnel option 1)
node hostweb.js deploy 1 myapp

# Using Cloudflare (tunnel option 2)
node hostweb.js deploy 2 myapp
```

**3. Get your public URL:**

```
✅ Project is live!
  Name      : myapp
  Framework : react-vite
  Port      : 3842
  URL       : https://your-subdomain.loca.lt
  Password  : 203.0.113.42
```

---

## Commands

| Command | Description |
|---|---|
| `deploy <tunnel> <name> [html]` | Deploy a project from `./web/<name>/` |
| `stop <name>` | Stop and delete a running project |
| `restart <name>` | Restart using existing config |
| `list` | List all running projects |
| `logs <name> [lines]` | Print recent log output (default: 20 lines) |
| `env <name> KEY=VALUE ...` | Set env vars and restart |
| `info <name>` | Show port, URL, framework, env vars |
| `help` | Show the help message |

### Tunnel options

| Value | Provider | Notes |
|---|---|---|
| `1` | LocalTunnel | Fast setup. Visitors must enter a password on first visit. |
| `2` | Cloudflare | Stable. No password. Requires `npx cloudflared` (auto-installed). |

---

## Examples

```bash
# Deploy a React app with Cloudflare tunnel
node hostweb.js deploy 2 my-react-app

# Deploy a quick inline HTML page
node hostweb.js deploy 1 hello "<h1>Hello, World!</h1>"

# View the last 50 log lines
node hostweb.js logs my-react-app 50

# Set environment variables and restart
node hostweb.js env my-react-app API_URL=https://api.example.com SECRET=abc123

# Check project details
node hostweb.js info my-react-app

# Stop a project
node hostweb.js stop my-react-app

# List all running projects
node hostweb.js list
```

---

## Supported Frameworks

| Framework | Detection | Build | Server |
|---|---|---|---|
| React (Vite) | `react` + `vite` in deps | `npm run build` | Express static (`dist/`) |
| React (CRA) | `react-scripts` in deps | `npm run build` | Express static (`build/`) |
| Vue (Vite) | `vue` + `vite` in deps | `npm run build` | Express static (`dist/`) |
| Vue (CLI) | `@vue/cli-service` in deps | `npm run build` | Express static (`dist/`) |
| Svelte (Vite) | `svelte` + `vite.config.js` | `npm run build` | Express static (`dist/`) |
| SvelteKit | `@sveltejs/kit` in deps | `npm run build` | `node build/index.js` |
| Next.js | `next` in deps | `npm run build` | `npm run start` |
| Nuxt | `nuxt` or `nuxt3` in deps | `npm run build` | `node .output/server/index.mjs` |
| Astro | `astro` in deps | `npm run build` | Express static (`dist/`) |
| Angular | `@angular/core` in deps | `npx ng build` | Express static (`dist/`) |
| TypeScript | `ts-node` / `tsx` in deps | — | `tsx` or `ts-node` |
| Node.js | `server.js` / `app.js` / `index.js` | — | `node <file>` |
| Python | `main.py` / `app.py` / `server.py` | pip install | `python <file>` |
| Static HTML | fallback | — | Express static |

---

## Project Directory Layout

```
./web/
  myapp/          ← project root (auto-created on first deploy)
    package.json
    src/
    ...
```

Files are deleted when you run `stop`. Use `restart` to redeploy without losing files.

---

## Environment Variables

The `PORT` environment variable is automatically set for all processes. Use the `env` command to inject additional variables:

```bash
node hostweb.js env myapi DATABASE_URL=postgres://localhost/mydb JWT_SECRET=supersecret
```

Variables persist across restarts within the same session.

---

## Notes

- Projects are stored in memory — they will be lost if the Node.js process exits.
- The `./web/<name>/` directory is **deleted** when you run `stop`. Back up any important files beforehand.
- For Python projects, make sure `python` and `pip` are available in your `PATH`.
- Cloudflare tunnels require internet access to install `cloudflared` via `npx`.

---

## License

MIT
