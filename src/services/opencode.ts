import { Duration, Effect, Layer, PlatformError, Redacted, Schedule, ServiceMap } from "effect"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { BinaryNotFound, HealthCheckFailed } from "./errors.js"
import { trim } from "../qr.js"
import { spawnInScope, streamToAppender } from "./process.js"

type Append = (line: string) => void
type Password = string | Redacted.Redacted<string>
type Env = Record<string, string>

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OpenCode extends ServiceMap.Service<
  OpenCode,
  {
    /** Start local OpenCode server and wait until health endpoint responds. */
    readonly start: (
      port: number,
      password: Password,
      append: Append,
    ) => Effect.Effect<ChildProcessHandle | undefined, BinaryNotFound | HealthCheckFailed | PlatformError.PlatformError>
  }
>()("@tailcode/OpenCode") {
  static readonly layer = Layer.effect(OpenCode)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      const scope = yield* Effect.scope

      const healthUrl = (port: number) => `http://127.0.0.1:${port}/global/health`

      const checkAlreadyHealthy: (port: number) => Effect.Effect<boolean> = (port) =>
        Effect.tryPromise({
          try: () => fetch(healthUrl(port)).then((r) => r.ok),
          catch: () => false as const,
        }).pipe(Effect.catch(() => Effect.succeed(false)))

      const resolveBinary: () => Effect.Effect<string, BinaryNotFound> = () => {
        const bin = Bun.which("opencode")
        return bin ? Effect.succeed(bin) : Effect.fail(new BinaryNotFound({ binary: "opencode" }))
      }

      const buildEnv: (password: Password) => Env = (password) => {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) env[k] = v
        }

        const passwordValue = Redacted.isRedacted(password) ? Redacted.value(password) : password
        if (passwordValue) env.OPENCODE_SERVER_PASSWORD = passwordValue

        return env
      }

      const spawnServer: (
        bin: string,
        port: number,
        env: Env,
      ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError> = (bin, port, env) =>
        spawnInScope(spawner, scope, bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
          env,
          extendEnv: false,
        })

      const attachOutput: (
        handle: ChildProcessHandle,
        append: Append,
      ) => Effect.Effect<{
        readonly getBuffer: () => string
      }> = (handle, append) => {
        let buffer = ""
        const fiber = streamToAppender(handle.all, (text) => {
          buffer = trim(buffer + text, 8000)
          append(text)
        })

        return Effect.forkIn(fiber, scope).pipe(
          Effect.as({
            getBuffer: () => buffer,
          }),
        )
      }

      const waitForHealth: (port: number) => Effect.Effect<void, HealthCheckFailed> = (port) =>
        Effect.tryPromise({
          try: () =>
            fetch(healthUrl(port)).then((r) => {
              if (!r.ok) throw new Error("not healthy")
            }),
          catch: () => new HealthCheckFailed({ message: "not healthy yet" }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(2),
            onTimeout: () =>
              Effect.fail(
                new HealthCheckFailed({
                  message: "health check timeout",
                }),
              ),
          }),
        )

      const failWithBuffer: (
        handle: ChildProcessHandle,
        getBuffer: () => string,
      ) => Effect.Effect<never, HealthCheckFailed> = (handle, getBuffer) =>
        Effect.gen(function* () {
          yield* handle.kill().pipe(Effect.ignore)
          return yield* new HealthCheckFailed({
            message: `OpenCode server did not become healthy\n${getBuffer()}`,
          })
        })

      const healthCheckPolicy = Schedule.spaced(Duration.millis(250)).pipe(Schedule.both(Schedule.recurs(40)))

      /** Start opencode bound to localhost and tie lifecycle to service scope. */
      const start = Effect.fn("OpenCode.start")(function* (port, password, append) {
        const alreadyHealthy = yield* checkAlreadyHealthy(port)

        if (alreadyHealthy) {
          append(`OpenCode server already running on 127.0.0.1:${port}\n`)
          return undefined
        }

        const bin = yield* resolveBinary()

        append(`Starting OpenCode server on 127.0.0.1:${port}...\n`)

        const env = buildEnv(password)
        const handle = yield* spawnServer(bin, port, env)
        const { getBuffer } = yield* attachOutput(handle, append)

        yield* Effect.retryOrElse(waitForHealth(port), healthCheckPolicy, () => failWithBuffer(handle, getBuffer))

        return handle
      })

      return {
        start,
      }
    }),
  )
}
