import { Effect, Layer, Redacted, ServiceMap } from "effect"
import { Tailscale } from "./tailscale.js"
import { OpenCode } from "./opencode.js"
import { AppConfig } from "./config.js"
import { CommandFailed, BinaryNotFound } from "./errors.js"

export class Tailnet extends ServiceMap.Service<
  Tailnet,
  {
    readonly start: (
      options: {
        readonly interactive: boolean
        readonly onLog?: (line: string) => void
      },
    ) => Effect.Effect<string, BinaryNotFound | CommandFailed>
  }
>()("@tailcode/Tailnet") {
  static readonly layer = Layer.effect(Tailnet)(
    Effect.gen(function* () {
      const config = yield* AppConfig
      const tailscale = yield* Tailscale
      const opencode = yield* OpenCode

      const start = Effect.fn("Tailnet.start")(function* (options: {
        interactive: boolean
        onLog?: (line: string) => void
      }) {
        const { interactive, onLog } = options
        const append = onLog ?? (() => {})

        const port = config.port
        const password = config.password as string | Redacted.Redacted<string>

        const bin = yield* Effect.gen(function* () {
          if (interactive) {
            return yield* tailscale.login(append)
          } else {
            return yield* tailscale.checkConnection()
          }
        })

        yield* opencode.start(port, password, append)

        const remote = yield* tailscale.publish(bin, port, append)

        return remote
      })

      return { start }
    }),
  )
}
