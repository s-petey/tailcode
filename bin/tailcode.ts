#!/usr/bin/env bun

import { BinaryNotFound, CommandFailed, HealthCheckFailed } from "../src/services/errors.js"

const DEFAULT_PORT = 4096

function printHelp() {
  process.stdout.write(
    `tailcode

Usage:
  tailcode [options]

Options:
  --start   Start the server and print the remote URL (no TUI)
  --attach  Attach to an already-running local OpenCode server
  --help    Show this help
`,
  )
}

function resolvePort() {
  const raw = process.env.TAILCODE_PORT
  if (!raw) return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT
}

async function isHealthy(port: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 600)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function runAttach(port: number) {
  const bin = Bun.which("opencode")
  if (!bin) {
    process.stderr.write("tailcode: 'opencode' is not installed\n")
    process.exit(1)
  }

  const target = `http://127.0.0.1:${port}`
  process.stdout.write(`tailcode: attaching to ${target}\n`)

  const child = Bun.spawn([bin, "attach", target], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  process.exit(await child.exited)
}

async function runTailscale(args: string[]): Promise<{ code: number; output: string }> {
  const bin = Bun.which("tailscale")
  if (!bin) {
    throw new BinaryNotFound({ binary: "tailscale" })
  }

  const child = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const output = await new TextDecoder().decode(await child.all)
  return { code: child.exitCode, output }
}

async function waitForTailscaleConnection(timeout = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await runTailscale(["ip", "-4"])
    if (result.code === 0) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("Timed out waiting for Tailscale to connect")
}

async function checkOpenCodeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/health`)
    return response.ok
  } catch {
    return false
  }
}

async function startOpenCode(port: number, password?: string): Promise<void> {
  const bin = Bun.which("opencode")
  if (!bin) {
    throw new BinaryNotFound({ binary: "opencode" })
  }

  const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
  const env: Record<string, string> = {}
  if (password) {
    env.OPENCODE_SERVER_PASSWORD = password
  }

  const child = Bun.spawn([bin, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const start = Date.now()
  const timeout = 30000
  while (Date.now() - start < timeout) {
    if (await checkOpenCodeHealth(port)) {
      return
    }
    await new Promise((r) => setTimeout(r, 250))
  }

  const output = await new TextDecoder().decode(await child.all)
  child.kill()
  throw new HealthCheckFailed({ message: `OpenCode server did not become healthy\n${output}` })
}

async function parseServeStatus(): Promise<Array<{ url: string; proxy: string | undefined }>> {
  const result = await runTailscale(["serve", "status", "--json"])
  if (result.code !== 0) return []

  const start = result.output.indexOf("{")
  if (start === -1) return []

  try {
    const status = JSON.parse(result.output.slice(start))
    const mappings: Array<{ url: string; proxy: string | undefined }> = []

    const addMappings = (web: Record<string, any>) => {
      if (!web) return
      for (const [host, endpoint] of Object.entries(web)) {
        const handlers = (endpoint as any).Handlers
        if (!handlers || Object.keys(handlers).length === 0) {
          mappings.push({ url: `https://${host}`, proxy: undefined })
          continue
        }
        for (const [path, handler] of Object.entries(handlers)) {
          const normalizedPath = path === "/" ? "" : path
          mappings.push({
            url: `https://${host}${normalizedPath}`,
            proxy: (handler as any).Proxy,
          })
        }
      }
    }

    if (status.Web) addMappings(status.Web)
    if (status.Foreground) {
      for (const node of Object.values(status.Foreground as Record<string, any>)) {
        addMappings((node as any).Web)
      }
    }
    if (status.Background) {
      for (const node of Object.values(status.Background as Record<string, any>)) {
        addMappings((node as any).Web)
      }
    }

    return mappings
  } catch {
    return []
  }
}

async function publishWithTailscale(port: number): Promise<string> {
  const target = `http://127.0.0.1:${port}`

  const statusMappings = await parseServeStatus()
  const existing = statusMappings.find((m) => m.proxy === target)
  if (existing) {
    process.stderr.write("Reusing existing tailscale serve listener.\n")
    return existing.url
  }

  process.stderr.write("Publishing with tailscale serve...\n")

  const child = Bun.spawn(["tailscale", "serve", "--bg", "--yes", "--https", String(port), target], {
    stdout: "pipe",
    stderr: "pipe",
  })

  const start = Date.now()
  const timeout = 30000
  while (Date.now() - start < timeout) {
    const mappings = await parseServeStatus()
    const found = mappings.find((m) => m.proxy === target)
    if (found) return found.url
    await new Promise((r) => setTimeout(r, 500))
  }

  const output = await new TextDecoder().decode(await child.all)
  if (output.includes("listener already exists")) {
    const match = output.match(/listener already exists for port\s+(\d+)/i)
    if (match) {
      const conflictPort = Number(match[1])
      process.stderr.write(`Port ${conflictPort} is already in use. Turning off existing HTTPS listener on that port and retrying once...\n`)
      await runTailscale(["serve", "--https", String(conflictPort), "off"])
    }
  }

  throw new Error("Timed out waiting for tailscale serve to register proxy")
}

async function runStart(port: number, password?: string) {
  try {
    process.stderr.write("Checking Tailscale connection...\n")
    await runTailscale(["ip", "-4"])
  } catch (e) {
    if (e instanceof BinaryNotFound) {
      process.stderr.write(`${e.binary} is not installed\n`)
      process.stderr.write(`\nRun 'tailcode' (without --start) for interactive setup.\n`)
      process.exit(1)
    }

    process.stderr.write("Tailscale is not connected. Starting login flow...\n")
    try {
      await runTailscale(["up", "--qr"])
    } catch {
      // Ignore errors from up command, it might show QR
    }

    try {
      await waitForTailscaleConnection()
    } catch {
      process.stderr.write("Tailscale issue: Timed out waiting for Tailscale to connect\n")
      process.stderr.write(`\nRun 'tailcode' (without --start) for interactive setup.\n`)
      process.exit(1)
    }
  }

  const alreadyHealthy = await checkOpenCodeHealth(port)
  if (!alreadyHealthy) {
    process.stderr.write(`Starting OpenCode server on 127.0.0.1:${port}...\n`)
    try {
      await startOpenCode(port, password)
    } catch (e) {
      if (e instanceof BinaryNotFound) {
        process.stderr.write(`${e.binary} is not installed\n`)
        process.exit(1)
      }
      if (e instanceof HealthCheckFailed) {
        process.stderr.write(`OpenCode server failed to start: ${e.message}\n`)
        process.exit(1)
      }
      throw e
    }
  } else {
    process.stderr.write(`OpenCode server already running on 127.0.0.1:${port}\n`)
  }

  const url = await publishWithTailscale(port)
  process.stdout.write(`${url}\n`)
}

const args = process.argv.slice(2)
const forceAttach = args.includes("--attach")
const startMode = args.includes("--start")

if (args.includes("--help") || args.includes("-h")) {
  printHelp()
  process.exit(0)
}

const port = resolvePort()
const password = process.env.TAILCODE_PASSWORD

if (forceAttach) {
  const healthy = await isHealthy(port)
  if (healthy) {
    await runAttach(port)
  } else {
    process.stderr.write(`tailcode: OpenCode is not running on http://127.0.0.1:${port}\n`)
    process.exit(1)
  }
}

if (startMode) {
  await runStart(port, password)
  process.exit(0)
}

// Default: always launch the wizard
await import("../src/main.tsx")
