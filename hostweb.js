#!/usr/bin/env node
/**
 * hostweb.js — Standalone Node.js Web Project Deployer
 *
 * Deploy any web project locally and expose it via a public tunnel.
 * Supports React, Vue, Svelte, Next.js, Nuxt, Astro, Angular,
 * plain Node.js, TypeScript, Python, and static HTML.
 *
 * Usage: node hostweb.js <command> [args...]
 * Run:   node hostweb.js help
 */

import fs from 'fs'
import path from 'path'
import net from 'net'
import express from 'express'
import localtunnel from 'localtunnel'
import { spawn, execSync } from 'child_process'
import unzipper from 'unzipper'
import fetch from 'node-fetch'

// ─────────────────────────────────────────────
//  Global project store
// ─────────────────────────────────────────────
globalThis.projects = globalThis.projects || {}

// ─────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────

/**
 * Find an available TCP port in the given range.
 */
function getAvailablePort(start = 3000, end = 10000) {
  return new Promise((resolve, reject) => {
    let port = start
    const test = () => {
      const server = net.createServer()
      server.once('error', () => {
        port++
        if (port > end) reject(new Error('No available port found in range'))
        else test()
      })
      server.once('listening', () => server.close(() => resolve(port)))
      server.listen(port)
    }
    test()
  })
}

/**
 * Append a timestamped log entry to a project's log buffer (max 200 lines).
 */
function appendLog(projectName, line) {
  if (!globalThis.projects[projectName]) return
  const logs = globalThis.projects[projectName].logs =
    globalThis.projects[projectName].logs || []
  const entry = `[${new Date().toLocaleTimeString()}] ${String(line).trim()}`
  logs.push(entry)
  if (logs.length > 200) logs.shift()
}

/**
 * Pipe stdout/stderr of a child process into the project log buffer.
 */
function attachProcessLogs(proc, projectName) {
  proc.stdout?.on('data', d => appendLog(projectName, d))
  proc.stderr?.on('data', d => appendLog(projectName, `ERR: ${d}`))
}

// ─────────────────────────────────────────────
//  Framework / language detection
// ─────────────────────────────────────────────

/**
 * Inspect a project directory and return its type along with
 * the appropriate build command, start command, and output directory.
 *
 * @returns {{ type, file?, buildCmd, startCmd, buildDir }}
 */
function detectProjectType(dir) {
  const has  = f => fs.existsSync(path.join(dir, f))
  const read = f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return {} }
  }

  const pkg  = read('package.json')
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }

  // ── Next.js ──────────────────────────────────
  if (deps['next'])
    return { type: 'next', buildCmd: 'npm run build', startCmd: 'npm run start', buildDir: null }

  // ── Nuxt ─────────────────────────────────────
  if (deps['nuxt'] || deps['nuxt3'])
    return { type: 'nuxt', buildCmd: 'npm run build', startCmd: 'node .output/server/index.mjs', buildDir: null }

  // ── Astro ─────────────────────────────────────
  if (deps['astro'])
    return { type: 'astro', buildCmd: 'npm run build', startCmd: null, buildDir: 'dist' }

  // ── SvelteKit ─────────────────────────────────
  if (deps['@sveltejs/kit'])
    return { type: 'sveltekit', buildCmd: 'npm run build', startCmd: 'node build/index.js', buildDir: null }

  // ── Svelte (Vite, no kit) ─────────────────────
  if (deps['svelte'] && has('vite.config.js'))
    return { type: 'svelte-vite', buildCmd: 'npm run build', startCmd: null, buildDir: 'dist' }

  // ── Vue ───────────────────────────────────────
  if (deps['vue']) {
    if (deps['@vue/cli-service'])
      return { type: 'vue-cli',  buildCmd: 'npm run build', startCmd: null, buildDir: 'dist' }
    return   { type: 'vue-vite', buildCmd: 'npm run build', startCmd: null, buildDir: 'dist' }
  }

  // ── React (Vite) ──────────────────────────────
  if (deps['react'] && (deps['vite'] || has('vite.config.js') || has('vite.config.ts')))
    return { type: 'react-vite', buildCmd: 'npm run build', startCmd: null, buildDir: 'dist' }

  // ── React (CRA) ───────────────────────────────
  if (deps['react'] && deps['react-scripts'])
    return { type: 'react-cra', buildCmd: 'npm run build', startCmd: null, buildDir: 'build' }

  // ── Angular ───────────────────────────────────
  if (deps['@angular/core'])
    return {
      type: 'angular',
      buildCmd: 'npx ng build --configuration production',
      startCmd: null,
      buildDir: 'dist'
    }

  // ── TypeScript node server ────────────────────
  if (deps['ts-node'] || deps['tsx']) {
    for (const f of ['server.ts', 'app.ts', 'index.ts'])
      if (has(f)) return { type: 'ts-node', file: f, buildCmd: null, startCmd: null, buildDir: null }
  }

  // ── Plain Node.js ─────────────────────────────
  for (const f of ['server.js', 'app.js', 'index.js'])
    if (has(f)) return { type: 'node', file: f, buildCmd: null, startCmd: null, buildDir: null }

  // ── Python ────────────────────────────────────
  for (const f of ['main.py', 'app.py', 'server.py'])
    if (has(f)) return { type: 'python', file: f, buildCmd: null, startCmd: null, buildDir: null }

  // ── Static HTML fallback ──────────────────────
  return { type: 'static', buildCmd: null, startCmd: null, buildDir: dir }
}

// ─────────────────────────────────────────────
//  Dependency installation helpers
// ─────────────────────────────────────────────

function installNodeDeps(dir) {
  if (fs.existsSync(path.join(dir, 'package.json')))
    try { execSync('npm install', { cwd: dir, stdio: 'ignore' }) } catch {}
}

function installPythonDeps(dir) {
  if (fs.existsSync(path.join(dir, 'requirements.txt')))
    try { execSync('pip install -r requirements.txt', { cwd: dir, stdio: 'ignore' }) } catch {}
}

// ─────────────────────────────────────────────
//  Process start helpers
// ─────────────────────────────────────────────

function spawnNode(dir, file, port, extraEnv = {}) {
  return spawn('node', [file], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...extraEnv }
  })
}

function spawnTsNode(dir, file, port, extraEnv = {}) {
  const runner = fs.existsSync(path.join(dir, 'node_modules/.bin/tsx')) ? 'tsx' : 'ts-node'
  return spawn(runner, [file], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...extraEnv }
  })
}

function spawnPython(dir, file, port, extraEnv = {}) {
  return spawn('python', [file], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...extraEnv }
  })
}

/**
 * Recursively search for a directory containing index.html (up to 5 levels deep).
 */
function findIndexHtmlDir(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir
  if (depth >= 5) return null
  try {
    for (const entry of fs.readdirSync(dir)) {
      const sub = path.join(dir, entry)
      try {
        if (fs.statSync(sub).isDirectory()) {
          const found = findIndexHtmlDir(sub, depth + 1)
          if (found) return found
        }
      } catch {}
    }
  } catch {}
  return null
}

/**
 * Serve a static directory with Express, with SPA fallback to index.html.
 */
function serveStatic(dir, port) {
  const serveDir = findIndexHtmlDir(dir) || dir
  console.log(`[static] Serving from: ${serveDir}`)
  const app = express()
  app.use(express.static(serveDir))
  app.get('*', (req, res) => {
    const indexFile = path.join(serveDir, 'index.html')
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile)
    } else {
      const contents = fs.readdirSync(serveDir).join(', ')
      res.status(404).send(`index.html not found. Directory contents: ${contents}`)
    }
  })
  return app.listen(port)
}

/**
 * Resolve the actual built output directory from common framework defaults.
 */
function resolveOutputDir(projectDir, hintDir) {
  const candidates = [
    hintDir,
    `dist/${path.basename(projectDir)}`,  // Angular default
    'dist/browser',                        // Angular v17+
    'build',
    'out',
    '.output/public'
  ]
  for (const candidate of candidates) {
    const full = path.join(projectDir, candidate)
    if (fs.existsSync(full)) return full
  }
  return path.join(projectDir, hintDir || 'dist')
}

// ─────────────────────────────────────────────
//  Tunnel providers
// ─────────────────────────────────────────────

/**
 * Create a LocalTunnel public URL for the given port.
 * Returns { tunnel, url, password }
 */
async function createLocalTunnel(port) {
  const tunnel = await localtunnel({ port })
  let password = 'unknown'
  try {
    const res = await fetch('https://loca.lt/mytunnelpassword')
    password = (await res.text()).trim()
  } catch {}
  return { tunnel, url: tunnel.url, password }
}

/**
 * Spawn a Cloudflare quick tunnel and wait for the public URL.
 * Returns { tunnel, url, password: '-' }
 */
function createCloudflareTunnel(port) {
  const tunnel = spawn(
    'npx',
    ['cloudflared', 'tunnel', '--url', `http://localhost:${port}`],
    { env: { ...process.env, NO_AUTOUPDATE: 'true' } }
  )

  return new Promise((resolve, reject) => {
    let resolved = false

    const timer = setTimeout(() => {
      if (!resolved) {
        tunnel.kill()
        reject(new Error('Cloudflared timed out (60s) — please try again'))
      }
    }, 60_000)

    const tryExtractUrl = text => {
      if (resolved) return
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
      if (match) {
        resolved = true
        clearTimeout(timer)
        // Wait 3 s for the tunnel to fully accept connections
        setTimeout(() => resolve({ tunnel, url: match[0], password: '-' }), 3000)
      }
    }

    tunnel.stdout.on('data', d => tryExtractUrl(d.toString()))
    tunnel.stderr.on('data', d => {
      console.log(d.toString())
      tryExtractUrl(d.toString())
    })

    tunnel.on('error', err => {
      clearTimeout(timer)
      reject(new Error(`Cloudflared process error: ${err.message}`))
    })

    tunnel.on('close', code => {
      if (!resolved) {
        clearTimeout(timer)
        reject(new Error(`Cloudflared exited unexpectedly (code ${code})`))
      }
    })
  })
}

// ─────────────────────────────────────────────
//  Wait for a local port to accept connections
// ─────────────────────────────────────────────

function waitForPort(port, timeout = 15000) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeout
    const check = () => {
      const sock = net.createConnection(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) resolve()   // timed out — continue anyway
        else setTimeout(check, 400)
      })
    }
    check()
  })
}

// ─────────────────────────────────────────────
//  Core deploy logic
// ─────────────────────────────────────────────

/**
 * Detect, build, start, and tunnel a project.
 * Stores the running project in globalThis.projects[name].
 *
 * @param {string} name        Project identifier
 * @param {string} dir         Absolute path to the project directory
 * @param {string} tunnelType  '1' = LocalTunnel, '2' = Cloudflare
 * @param {object} extraEnv    Additional environment variables
 * @returns {{ port, url, password, framework }}
 */
async function deployProject(name, dir, tunnelType, extraEnv = {}) {
  const info = detectProjectType(dir)

  installNodeDeps(dir)
  if (info.type === 'python') installPythonDeps(dir)

  const port = await getAvailablePort()
  let server = null

  // ── Build step (SPA / SSG frameworks) ─────────
  if (info.buildCmd) {
    appendLog(name, `Building project (${info.type})…`)
    try {
      execSync(info.buildCmd, {
        cwd: dir,
        env: { ...process.env, PORT: String(port), ...extraEnv },
        stdio: 'pipe'
      })
    } catch (err) {
      appendLog(name, `Build failed: ${err.message}`)
      throw new Error(`Build failed — run: node hostweb.js logs ${name}`)
    }
  }

  // ── Start server ───────────────────────────────
  if (info.startCmd) {
    // SSR frameworks with their own start command
    const [cmd, ...args] = info.startCmd.split(' ')
    server = spawn(cmd, args, {
      cwd: dir,
      env: { ...process.env, PORT: String(port), ...extraEnv }
    })
  } else if (info.buildDir !== null) {
    // SPA / SSG — serve the built output statically
    const outputDir = resolveOutputDir(dir, info.buildDir)
    server = serveStatic(outputDir, port)
  } else if (info.type === 'ts-node') {
    server = spawnTsNode(dir, info.file, port, extraEnv)
  } else if (info.type === 'node') {
    server = spawnNode(dir, info.file, port, extraEnv)
  } else if (info.type === 'python') {
    server = spawnPython(dir, info.file, port, extraEnv)
  } else {
    server = serveStatic(dir, port)
  }

  if (server && typeof server.stdout !== 'undefined') attachProcessLogs(server, name)

  // ── Wait for server to be ready ────────────────
  await waitForPort(port)

  // ── Open tunnel ────────────────────────────────
  let result
  if      (tunnelType === '1') result = await createLocalTunnel(port)
  else if (tunnelType === '2') result = await createCloudflareTunnel(port)
  else throw new Error('Invalid tunnel type — use 1 (LocalTunnel) or 2 (Cloudflare)')

  // ── Store project state ────────────────────────
  globalThis.projects[name] = {
    dir,
    port,
    server,
    tunnel:    result.tunnel,
    url:       result.url,
    framework: info.type,
    env:       extraEnv,
    tunnelType,
    logs:      [],
    startedAt: new Date().toISOString()
  }

  appendLog(name, `Project is online — ${result.url}`)
  return { port, url: result.url, password: result.password, framework: info.type }
}

// ─────────────────────────────────────────────
//  Stop a running project (reusable helper)
// ─────────────────────────────────────────────

async function stopProject(name, deleteFiles = true) {
  const project = globalThis.projects[name]
  if (!project) throw new Error(`Project "${name}" not found`)

  if (project.server?.close) project.server.close()
  if (project.server?.kill)  project.server.kill()
  if (project.tunnel?.close) await project.tunnel.close?.()
  if (project.tunnel?.kill)  project.tunnel.kill()

  if (deleteFiles && fs.existsSync(project.dir))
    fs.rmSync(project.dir, { recursive: true, force: true })

  delete globalThis.projects[name]
}

// ─────────────────────────────────────────────
//  Output helper
// ─────────────────────────────────────────────

const print = msg => console.log(msg)

// ─────────────────────────────────────────────
//  Help text
// ─────────────────────────────────────────────

const HELP = `
╔══════════════════════════════════════════════════╗
║           hostweb — Web Project Deployer         ║
╚══════════════════════════════════════════════════╝

TUNNEL OPTIONS
  1  LocalTunnel   — fast, requires password on first visit
  2  Cloudflare    — stable, no password (auto-installs cloudflared)

COMMANDS
  deploy <tunnel> <name> [html]
      Deploy a project from ./web/<name>/ directory.
      Pass inline HTML as the third argument for a quick static page.
      Tunnel: 1 = LocalTunnel, 2 = Cloudflare

  stop <name>
      Stop and delete a running project.

  restart <name>
      Restart a project using its existing configuration.

  list
      Show all currently running projects.

  logs <name> [lines]
      Print the last N log lines for a project (default: 20).

  env <name> KEY=VALUE [KEY2=VALUE2 ...]
      Set environment variables and restart the project.

  info <name>
      Show port, URL, framework, and env vars for a project.

  help
      Show this help message.

EXAMPLES
  node hostweb.js deploy 1 myblog
  node hostweb.js deploy 2 myapi
  node hostweb.js deploy 1 quickpage "<h1>Hello World</h1>"
  node hostweb.js env myapi DATABASE_URL=postgres://... SECRET=abc
  node hostweb.js logs myapi 50
  node hostweb.js stop myblog

PROJECT DIRECTORY
  Place your project files in: ./web/<name>/
  The tool will auto-detect the framework and run the right commands.

SUPPORTED FRAMEWORKS
  React (Vite & CRA)   Vue (Vite & CLI)    Svelte / SvelteKit
  Next.js              Nuxt                Astro
  Angular              TypeScript (tsx)    Plain Node.js
  Python (Flask, FastAPI, etc.)           Static HTML / CSS / JS
`

// ─────────────────────────────────────────────
//  CLI entry point
// ─────────────────────────────────────────────

async function main() {
  const [,, command, ...rawArgs] = process.argv
  const args = rawArgs.filter(Boolean)
  const rest = args.join(' ').trim()

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    print(HELP)
    return
  }

  // ── deploy ────────────────────────────────────
  if (command === 'deploy') {
    const tunnelType = args[0]
    const name       = args[1]

    if (!tunnelType || !name) {
      print('Usage: node hostweb.js deploy <tunnel> <name> [html]\nExample: node hostweb.js deploy 1 myapp')
      return
    }

    if (globalThis.projects[name]) {
      print(`Project "${name}" is already running.\nStop it first: node hostweb.js stop ${name}`)
      return
    }

    const dir = path.resolve(`./web/${name}`)
    fs.mkdirSync(dir, { recursive: true })

    // Optional inline HTML
    const inlineHtml = args.slice(2).join(' ').trim()
    if (inlineHtml) fs.writeFileSync(path.join(dir, 'index.html'), inlineHtml)

    try {
      print(`Deploying "${name}"…`)
      const { port, url, password, framework } = await deployProject(name, dir, tunnelType)
      print(
        `\n✅ Project is live!\n` +
        `  Name      : ${name}\n` +
        `  Framework : ${framework}\n` +
        `  Port      : ${port}\n` +
        `  URL       : ${url}\n` +
        `  Password  : ${password}\n`
      )
    } catch (err) {
      print(`Deploy failed: ${err.message}`)
      console.error(err)
    }
    return
  }

  // ── stop ──────────────────────────────────────
  if (command === 'stop') {
    const name = args[0]
    if (!name) { print('Usage: node hostweb.js stop <name>'); return }

    try {
      await stopProject(name, true)
      print(`Project "${name}" has been stopped and removed.`)
    } catch (err) {
      print(`Error: ${err.message}`)
    }
    return
  }

  // ── restart ───────────────────────────────────
  if (command === 'restart') {
    const name = args[0]
    if (!name) { print('Usage: node hostweb.js restart <name>'); return }

    const project = globalThis.projects[name]
    if (!project) { print(`Project "${name}" not found.`); return }

    const { dir, tunnelType, env } = project
    try {
      await stopProject(name, false)   // keep files, just stop processes

      print(`Restarting "${name}"…`)
      const { port, url, password, framework } = await deployProject(name, dir, tunnelType, env)
      print(
        `\n✅ Restarted successfully!\n` +
        `  Name      : ${name}\n` +
        `  Framework : ${framework}\n` +
        `  Port      : ${port}\n` +
        `  URL       : ${url}\n` +
        `  Password  : ${password}\n`
      )
    } catch (err) {
      print(`Restart failed: ${err.message}`)
      console.error(err)
    }
    return
  }

  // ── list ──────────────────────────────────────
  if (command === 'list') {
    const entries = Object.entries(globalThis.projects)
    if (!entries.length) { print('No projects are currently running.'); return }

    print('\nRunning projects:\n')
    for (const [name, p] of entries) {
      const uptimeMin = p.startedAt
        ? Math.floor((Date.now() - new Date(p.startedAt)) / 60_000)
        : null
      const uptime = uptimeMin !== null ? `${uptimeMin} min` : 'unknown'
      print(
        `  ${name}\n` +
        `    Framework : ${p.framework || 'unknown'}\n` +
        `    Port      : ${p.port}\n` +
        `    URL       : ${p.url || 'N/A'}\n` +
        `    Uptime    : ${uptime}\n`
      )
    }
    return
  }

  // ── logs ──────────────────────────────────────
  if (command === 'logs') {
    const name  = args[0]
    const lines = parseInt(args[1]) || 20

    if (!name) { print('Usage: node hostweb.js logs <name> [lines]'); return }

    const project = globalThis.projects[name]
    if (!project) { print(`Project "${name}" not found.`); return }

    const logLines = (project.logs || []).slice(-lines)
    if (!logLines.length) { print(`No logs available for "${name}" yet.`); return }

    print(`\nLogs for "${name}" (last ${logLines.length} lines):\n`)
    print(logLines.join('\n'))
    return
  }

  // ── env ───────────────────────────────────────
  if (command === 'env') {
    const name    = args[0]
    const kvPairs = args.slice(1)

    if (!name || !kvPairs.length) {
      print('Usage: node hostweb.js env <name> KEY=VALUE [KEY2=VALUE2 ...]')
      return
    }

    const project = globalThis.projects[name]
    if (!project) { print(`Project "${name}" not found.`); return }

    // Parse KEY=VALUE pairs
    const newEnv = { ...project.env }
    for (const kv of kvPairs) {
      const idx = kv.indexOf('=')
      if (idx < 1) { print(`Skipping invalid pair: "${kv}" (expected KEY=VALUE)`); continue }
      newEnv[kv.slice(0, idx)] = kv.slice(idx + 1)
    }

    const { dir, tunnelType } = project
    try {
      await stopProject(name, false)

      print(`Applying environment variables and restarting "${name}"…`)
      const { port, url, password, framework } = await deployProject(name, dir, tunnelType, newEnv)

      const envSummary = Object.entries(newEnv).map(([k, v]) => `    ${k}=${v}`).join('\n')
      print(
        `\n✅ Environment updated and project restarted!\n` +
        `  Name      : ${name}\n` +
        `  Framework : ${framework}\n` +
        `  Port      : ${port}\n` +
        `  URL       : ${url}\n` +
        `  Password  : ${password}\n\n` +
        `  Active env vars:\n${envSummary}\n`
      )
    } catch (err) {
      print(`Failed to apply env: ${err.message}`)
      console.error(err)
    }
    return
  }

  // ── info ──────────────────────────────────────
  if (command === 'info') {
    const name = args[0]
    if (!name) { print('Usage: node hostweb.js info <name>'); return }

    const project = globalThis.projects[name]
    if (!project) { print(`Project "${name}" not found.`); return }

    const envKeys = Object.keys(project.env || {})
    print(
      `\nProject info: ${name}\n` +
      `  Framework : ${project.framework || 'unknown'}\n` +
      `  Port      : ${project.port}\n` +
      `  URL       : ${project.url || 'N/A'}\n` +
      `  Env vars  : ${envKeys.length ? envKeys.join(', ') : '(none)'}\n` +
      `  Started   : ${project.startedAt || 'unknown'}\n`
    )
    return
  }

  print(`Unknown command: "${command}"\nRun: node hostweb.js help`)
  process.exit(1)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
