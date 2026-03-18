#!/usr/bin/env bun

import { Effect, Layer } from "effect"
import { AppConfig } from "../src/services/config.js"
import { Tailscale } from "../src/services/tailscale.js"
import { OpenCode } from "../src/services/opencode.js"
import { Tailnet } from "../src/services/tailnet.js"
import { BunServices } from "@effect/platform-bun"
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

async function runStart(port: number) {
  const runtime = Layer.mergeAll(AppConfig.layer, Tailscale.layer, OpenCode.layer, BunServices.layer).pipe(
    Layer.build,
  )

  const program = Effect.gen(function* () {
    const tailnet = yield* Tailnet
    const url = yield* tailnet.start({ interactive: false, onLog: (line) => process.stderr.write(line) })
    return url
  })

  const url = await Effect.runPromise(Effect.provide(program, runtime))
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
  await runStart(port)
  process.exit(0)
}

// Default: launch the wizard (TUI)
await import("../src/main.tsx")
