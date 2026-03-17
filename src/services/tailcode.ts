import { Effect, Layer, ServiceMap } from "effect"
import { BinaryNotFound, CommandFailed, HealthCheckFailed } from "./errors.js"
import { Tailscale } from "./tailscale.js"
import { OpenCode } from "./opencode.js"
import { AppConfig } from "./config.js"
import type { PlatformError } from "effect"

export class TailCode extends ServiceMap.Service<
  TailCode,
  {
    readonly run: () => Effect.Effect<string, BinaryNotFound | CommandFailed | HealthCheckFailed | PlatformError.PlatformError>
  }
>()("@tailcode/TailCode") {
  static readonly layer = Layer.effect(TailCode)(
    Effect.gen(function* () {
      const config = yield* AppConfig
      const tailscale = yield* Tailscale
      const opencode = yield* OpenCode

      const run = Effect.fn("TailCode.run")(function* () {
        const bin = yield* tailscale.ensure(() => {})

        yield* opencode.start(config.port, config.password, () => {})

        const remote = yield* tailscale.publish(bin, config.port, () => {})

        return remote
      })

      return {
        run,
      }
    }),
  )
}
