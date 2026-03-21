#!/usr/bin/env bun

export {}

import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { OpenCode } from "../src/services/opencode.js"
import { Tailscale } from "../src/services/tailscale.js"
import { BinaryNotFound } from "../src/services/errors.ts"

const DEFAULT_PORT = 4096

function printHelp() {
  process.stdout.write(
    `tailcode\n\nUsage:\n  tailcode [start] [--attach] [--help]\n\nCommands:\n  start     Start headless, publish URL, and keep running (no attach UI)\n\nOptions:\n  --attach  Attach to an already-running local OpenCode server\n  --help    Show this help\n`,
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

const SETUP_HINT = "Run 'tailcode' to set it up interactively."

function waitForShutdownSignal() {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      resolve()
    }

    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)
  })
}

async function runStart(port: number) {
  const opencodeBin = Bun.which("opencode")
  if (!opencodeBin) {
    process.stderr.write(`tailcode: 'opencode' is not installed. ${SETUP_HINT}\n`)
    process.exit(1)
  }

  const tailscaleBin = Bun.which("tailscale")
  if (!tailscaleBin) {
    process.stderr.write(`tailcode: 'tailscale' is not installed. ${SETUP_HINT}\n`)
    process.exit(1)
  }

  const services = Layer.mergeAll(OpenCode.layer, Tailscale.layer).pipe(Layer.provideMerge(BunServices.layer))

  const append = (_line: string) => undefined

  const program = Effect.scoped(
    Effect.gen(function* () {
      const opencode = yield* OpenCode
      const tailscale = yield* Tailscale

      process.stdout.write("tailcode: checking tailscale...\n")
      const tailscaleBin = yield* tailscale.ensure(append)

      process.stdout.write("tailcode: starting OpenCode...\n")
      yield* opencode.start(port, process.env.TAILCODE_PASSWORD ?? "", append)

      process.stdout.write("tailcode: publishing on tailnet...\n")
      const remote = yield* tailscale.publish(tailscaleBin, port, append)

      process.stdout.write(`${remote}\n`)
      process.stdout.write("tailcode: running (Ctrl+C to stop)\n")

      yield* Effect.promise(() => waitForShutdownSignal())
    }),
  ).pipe(Effect.provide(services))

  try {
    await Effect.runPromise(program)
    process.exit(0)
  } catch (error) {
    if (error instanceof BinaryNotFound) {
      process.stderr.write(`tailcode: ${error.binary} is not installed. ${SETUP_HINT}\n`)
      process.exit(1)
    }

    process.stderr.write(`tailcode: Unable to start headless flow. ${SETUP_HINT}\n`)
    process.exit(1)
  }
}

const args = process.argv.slice(2)
const forceAttach = args.includes("--attach")
const runStartCommand = args[0] === "start"

if (args.includes("--help") || args.includes("-h")) {
  printHelp()
  process.exit(0)
}

const port = resolvePort()

if (runStartCommand) {
  await runStart(port)
}

if (forceAttach) {
  const healthy = await isHealthy(port)
  if (healthy) {
    await runAttach(port)
  } else {
    process.stderr.write(`tailcode: OpenCode is not running on http://127.0.0.1:${port}\n`)
    process.exit(1)
  }
}

// Default: always launch the wizard
await import("../src/main.tsx")
