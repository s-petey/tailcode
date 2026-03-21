import { BunServices } from "@effect/platform-bun"
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

const originalFetch = globalThis.fetch

const spawnState: {
  calls: Array<{
    bin: string
    args: string[]
    options: Record<string, unknown> | undefined
  }>
  handle: ChildProcessHandle
} = {
  calls: [],
  handle: undefined as unknown as ChildProcessHandle,
}

const streamState = {
  output: "",
}

mock.module("./process.js", () => ({
  spawnInScope: (
    _spawner: unknown,
    _scope: unknown,
    bin: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => {
    spawnState.calls.push({ bin, args, options })
    return Effect.succeed(spawnState.handle)
  },
  streamToAppender: (_stream: unknown, append: (line: string) => void) =>
    Effect.sync(() => {
      if (!streamState.output) return
      append(streamState.output)
    }),
  // @effect-diagnostics-next-line globalErrorInEffectFailure:off
  spawnExitCode: () => Effect.fail(new Error("spawnExitCode is not used in opencode tests")),
  // @effect-diagnostics-next-line globalErrorInEffectFailure:off
  spawnString: () => Effect.fail(new Error("spawnString is not used in opencode tests")),
  ignoreErrors: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.match(effect, {
      onFailure: () => undefined,
      onSuccess: () => undefined,
    }),
}))

const { OpenCode } = await import("./opencode.js")

function makeHandle(): ChildProcessHandle & { killed: boolean } {
  let killed = false

  return {
    // @ts-ignore -- Ignoring mismatcheced mock type
    all: {},
    kill: () =>
      Effect.sync(() => {
        killed = true
      }),
    get killed() {
      return killed
    },
  }
}

function setFetchSequence(sequence: ReadonlyArray<"ok" | "bad" | "throw">) {
  let index = 0
  spyOn(globalThis, "fetch").mockImplementation(
    // @ts-expect-error -- mocking fetch preconnect is missing?
    async () => {
      const current = sequence[index] ?? sequence[sequence.length - 1] ?? "bad"
      index += 1
      if (current === "throw") throw new Error("network")
      return new Response("", { status: current === "ok" ? 200 : 503 })
    },
  )
}

async function runStart(
  password: string | Redacted.Redacted<string>,
  append: (line: string) => void = () => undefined,
) {
  const program = Effect.gen(function* () {
    const opencode = yield* OpenCode
    return yield* opencode.start(4096, password, append)
  }).pipe(Effect.provide(Layer.mergeAll(OpenCode.layer).pipe(Layer.provideMerge(BunServices.layer))))

  return Effect.runPromise(program)
}

beforeEach(() => {
  spawnState.calls = []
  streamState.output = ""
  spawnState.handle = makeHandle()
  setFetchSequence(["bad", "ok"])
  spyOn(Bun, "which").mockImplementation((binary: string) => (binary === "opencode" ? "/tmp/opencode" : null))
})

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
})

test("returns undefined when server is already healthy", async () => {
  const lines: string[] = []
  setFetchSequence(["ok"])

  const result = await runStart("pw", (line) => lines.push(line))

  expect(result).toBeUndefined()
  expect(spawnState.calls).toHaveLength(0)
  expect(lines.join("")).toContain("already running")
})

test("fails with BinaryNotFound when opencode binary is missing", async () => {
  spyOn(Bun, "which").mockImplementation(() => null)
  setFetchSequence(["bad"])

expect(runStart("pw")).rejects.toMatchObject({
    _tag: "BinaryNotFound",
    binary: "opencode",
  })
  expect(spawnState.calls).toHaveLength(0)
})

test("spawns server and returns handle once health check succeeds", async () => {
  const handle = makeHandle()
  spawnState.handle = handle
  setFetchSequence(["bad", "bad", "ok"])

  const result = await runStart("pw")

  expect(result).toBe(handle)
  expect(spawnState.calls).toHaveLength(1)
  expect(spawnState.calls[0]?.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4096"])
})

test("kills process and includes buffered output when health never becomes ready", async () => {
  const handle = makeHandle()
  spawnState.handle = handle
  streamState.output = "boot line\n"
  setFetchSequence(["bad", "bad"])

  let thrown: unknown
  try {
    await runStart("pw")
  } catch (error) {
    thrown = error
  }

  expect(thrown).toMatchObject({
    _tag: "HealthCheckFailed",
    message: expect.stringContaining("boot line"),
  })
  expect(handle.killed).toBe(true)
}, 15000)

test("sets OPENCODE_SERVER_PASSWORD from plain and redacted values", async () => {
  setFetchSequence(["bad", "ok"])
  await runStart("plain-password")

  let foundPassword: string | null = null
  const possibleEnv = spawnState.calls[0]?.options?.env
  if (
    typeof possibleEnv === "object" &&
    possibleEnv !== null &&
    "OPENCODE_SERVER_PASSWORD" in possibleEnv &&
    typeof possibleEnv.OPENCODE_SERVER_PASSWORD === "string"
  ) {
    foundPassword = possibleEnv.OPENCODE_SERVER_PASSWORD
  }

  expect(foundPassword).toBe("plain-password")

  spawnState.calls = []
  setFetchSequence(["bad", "ok"])
  await runStart(Redacted.make("secret-password"))

  const secondEnv = (spawnState.calls[0]?.options?.env as Record<string, string> | undefined) ?? {}
  expect(secondEnv.OPENCODE_SERVER_PASSWORD).toBe("secret-password")
})

test("forwards process output to append callback", async () => {
  const lines: string[] = []
  streamState.output = "hello from opencode\n"
  setFetchSequence(["bad", "bad", "ok"])

  await runStart("pw", (line) => lines.push(line))
  await Bun.sleep(5)

  expect(lines.join("")).toContain("hello from opencode")
})
