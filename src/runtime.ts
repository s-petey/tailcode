import * as Atom from "effect/unstable/reactivity/Atom"
import { Layer } from "effect"
import { AppConfig } from "./services/config.js"
import { BunServices } from "@effect/platform-bun"
import { Tailscale } from "./services/tailscale.js"
import { OpenCode } from "./services/opencode.js"
import { TailCode } from "./services/tailcode.js"

export const appRuntime = Atom.runtime(
  Layer.mergeAll(
    AppConfig.layer,
    BunServices.layer,
    Tailscale.layer,
    OpenCode.layer,
    TailCode.layer,
  ),
)
