import { BunServices } from "@effect/platform-bun"
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"

const processState: {
  exitCodeCalls: Array<{ bin: string; args: string[] }>
  stringCalls: Array<{ bin: string; args: string[] }>
  spawnCalls: Array<{ bin: string; args: string[] }>
  streamOutputs: string[]
  exitCodeByCommand: Map<string, number[]>
  stringByCommand: Map<string, string[]>
  onSpawn: undefined | ((count: number) => void)
} = {
  exitCodeCalls: [],
  stringCalls: [],
  spawnCalls: [],
  streamOutputs: [],
  exitCodeByCommand: new Map<string, number[]>(),
  stringByCommand: new Map<string, string[]>(),
  onSpawn: undefined,
}

const commandKey = (bin: string, args: string[]) => `${bin} ${args.join(" ")}`

const dequeue = <T>(map: Map<string, T[]>, key: string, fallback: T): T => {
  const queue = map.get(key)
  if (!queue || queue.length === 0) return fallback
  const value = queue.shift()
  if (queue.length === 0) map.delete(key)
  return value ?? fallback
}

const setExitCodes = (bin: string, args: string[], values: number[]) => {
  processState.exitCodeByCommand.set(commandKey(bin, args), [...values])
}

const setStringOutputs = (bin: string, args: string[], values: string[]) => {
  processState.stringByCommand.set(commandKey(bin, args), [...values])
}

const setStreamOutputs = (values: string[]) => {
  processState.streamOutputs = [...values]
}

mock.module("./process.js", () => ({
  spawnExitCode: (_spawner: unknown, bin: string, args: string[]) =>
    Effect.sync(() => {
      processState.exitCodeCalls.push({ bin, args })
      return dequeue(processState.exitCodeByCommand, commandKey(bin, args), 0)
    }),
  spawnString: (_spawner: unknown, bin: string, args: string[]) =>
    Effect.sync(() => {
      processState.stringCalls.push({ bin, args })
      return dequeue(processState.stringByCommand, commandKey(bin, args), "")
    }),
  spawnInScope: (_spawner: unknown, _scope: unknown, bin: string, args: string[]) =>
    Effect.sync(() => {
      processState.spawnCalls.push({ bin, args })
      processState.onSpawn?.(processState.spawnCalls.length)
      return { all: {} }
    }),
  streamToAppender: (_stream: unknown, append: (line: string) => void) =>
    Effect.sync(() => {
      const next = processState.streamOutputs.shift() ?? ""
      if (!next) return
      append(next)
    }),
  ignoreErrors: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.match(effect, {
      onFailure: () => undefined,
      onSuccess: () => undefined,
    }),
  command: (_bin: string, _args: string[], _options?: Record<string, unknown>) => ({}),
}))

const { Tailscale } = await import("./tailscale.js")

async function runEnsure(append: (line: string) => void = () => undefined) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const tailscale = yield* Tailscale
      return yield* tailscale.ensure(append)
    }).pipe(Effect.provide(Tailscale.layer), Effect.provide(BunServices.layer)),
  )
}

async function runPublish(bin: string, port: number, append: (line: string) => void = () => undefined) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const tailscale = yield* Tailscale
      return yield* tailscale.publish(bin, port, append)
    }).pipe(Effect.provide(Tailscale.layer), Effect.provide(BunServices.layer)),
  )
}

beforeEach(() => {
  processState.exitCodeCalls = []
  processState.stringCalls = []
  processState.spawnCalls = []
  processState.streamOutputs = []
  processState.exitCodeByCommand.clear()
  processState.stringByCommand.clear()
  processState.onSpawn = undefined
  spyOn(Bun, "which").mockImplementation((binary: string) => (binary === "tailscale" ? "/tmp/tailscale" : null))
})

afterEach(() => {
  mock.restore()
})

test("ensure returns tailscale binary when already connected", async () => {
  setExitCodes("/tmp/tailscale", ["ip", "-4"], [0])

  const result = await runEnsure()

  expect(result).toBe("/tmp/tailscale")
  expect(processState.stringCalls).toHaveLength(0)
})

test("ensure fails with BinaryNotFound when tailscale is missing", async () => {
  spyOn(Bun, "which").mockImplementation(() => null)

  expect(runEnsure()).rejects.toMatchObject({
    _tag: "BinaryNotFound",
    binary: "tailscale",
  })
})

test("ensure runs login flow and appends URL instructions", async () => {
  const lines: string[] = []

  setExitCodes("/tmp/tailscale", ["ip", "-4"], [1, 0])
  setStringOutputs("/tmp/tailscale", ["up", "--qr"], ["Please open https://login.tailscale.test/auth now"])

  const result = await runEnsure((line) => lines.push(line))

  expect(result).toBe("/tmp/tailscale")
  expect(lines.join("\n")).toContain("Open this URL (or scan QR): https://login.tailscale.test/auth")
})

test("ensure appends terminal login instructions when no login URL is present", async () => {
  const lines: string[] = []

  setExitCodes("/tmp/tailscale", ["ip", "-4"], [1, 0])
  setStringOutputs("/tmp/tailscale", ["up", "--qr"], ["Visit your browser manually to continue login"])

  const result = await runEnsure((line) => lines.push(line))

  expect(result).toBe("/tmp/tailscale")
  expect(lines.join("\n")).toContain("Follow the Tailscale login prompts in your terminal.")
  expect(lines.join("\n")).toContain("Visit your browser manually to continue login")
})

test("publish reuses existing listener when target already mapped", async () => {
  setStringOutputs(
    "/tmp/tailscale",
    ["serve", "status", "--json"],
    [
      JSON.stringify({
        Web: {
          "demo.ts.net": {
            Handlers: {
              "/": {
                Proxy: "http://127.0.0.1:4096",
              },
            },
          },
        },
      }),
    ],
  )

  const result = await runPublish("/tmp/tailscale", 4096)

  expect(result).toBe("https://demo.ts.net")
  expect(processState.spawnCalls).toHaveLength(0)
})

test("publish spawns serve and returns remote URL once proxy appears", async () => {
  const lines: string[] = []

  setStringOutputs(
    "/tmp/tailscale",
    ["serve", "status", "--json"],
    [
      JSON.stringify({ Web: {} }),
      JSON.stringify({
        Web: {
          "demo.ts.net": {
            Handlers: {
              "/": {
                Proxy: "http://127.0.0.1:4096",
              },
            },
          },
        },
      }),
    ],
  )

  const result = await runPublish("/tmp/tailscale", 4096, (line) => lines.push(line))

  expect(result).toBe("https://demo.ts.net")
  expect(processState.spawnCalls).toHaveLength(1)
  expect(processState.spawnCalls[0]?.args).toEqual([
    "serve",
    "--bg",
    "--yes",
    "--https",
    "4096",
    "http://127.0.0.1:4096",
  ])
  expect(lines.join("\n")).toContain("Publishing with tailscale serve")
})

test("publish retries once after listener conflict and then succeeds", async () => {
  const lines: string[] = []
  const serveStatusArgs = ["serve", "status", "--json"]

  setStringOutputs("/tmp/tailscale", serveStatusArgs, [JSON.stringify({ Web: {} })])
  setStreamOutputs(["listener already exists for port 4096\n", "retry boot\n"])
  processState.onSpawn = (count) => {
    if (count !== 2) return
    setStringOutputs("/tmp/tailscale", serveStatusArgs, [
      JSON.stringify({
        Web: {
          "demo.ts.net": {
            Handlers: {
              "/": {
                Proxy: "http://127.0.0.1:4096",
              },
            },
          },
        },
      }),
    ])
  }

  const result = await runPublish("/tmp/tailscale", 4096, (line) => lines.push(line))

  expect(result).toBe("https://demo.ts.net")
  expect(processState.spawnCalls).toHaveLength(2)
  expect(lines.join("\n")).toContain("Turning off existing HTTPS listener")
}, 25000)

test("publish fails with manual cleanup message after repeated conflict", async () => {
  const serveStatusArgs = ["serve", "status", "--json"]

  setStringOutputs("/tmp/tailscale", serveStatusArgs, [JSON.stringify({ Web: {} })])
  setStreamOutputs(["listener already exists for port 4096\n", "listener already exists for port 4096\n"])

  expect(runPublish("/tmp/tailscale", 4096)).rejects.toMatchObject({
    _tag: "CommandFailed",
    command: "tailscale serve",
    message: expect.stringContaining("Please run 'tailscale serve --https 4096 off' manually and retry."),
  })
  expect(processState.spawnCalls).toHaveLength(2)
}, 45000)
