/** @jsxImportSource @opentui/solid */
/**
 * openbot, terminal side: Ctrl+P commands, a Bots list in the session sidebar,
 * and the bot inspector. Loaded by the opencode TUI from the package's `./tui`
 * export (TSX source, transpiled by the host). All logic lives in flows.ts.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { debugEnabled } from "../dist/debug/enabled.js"
import { botMenuFlow, botsFlow, createBotFlow, diagnoseFlow, type FlowDeps } from "../dist/flows.js"
import { resolveRoot } from "../dist/paths.js"
import { makeService } from "../dist/service.js"
import { BotStore } from "../dist/store.js"
import type { BotConfig } from "../dist/types.js"

function BotsSidebar(props: { store: BotStore; muted: any; open: (name: string) => void }) {
  const [bots, setBots] = createSignal<BotConfig[]>(props.store.list())
  const timer = setInterval(() => setBots(props.store.list()), 2500)
  onCleanup(() => clearInterval(timer))
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={props.muted}>{`Bots (${bots().length})`}</text>
      <Show when={bots().length} fallback={<text fg={props.muted}>none yet: Ctrl+P, Create bot</text>}>
        <For each={bots()}>
          {(b) => (
            <box onMouseUp={() => props.open(b.name)}>
              <text>{`@${b.name}  ${b.model ?? "default model"}`}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

const plugin: Plugin.Definition = {
  id: "openbot",
  setup(context) {
    const options = (context.options ?? {}) as Record<string, unknown>
    const store = new BotStore(resolveRoot(options))
    const debug = debugEnabled(options)
    const deps: FlowDeps = { ctx: context, store, service: makeService(store, { materialize: options.materialize !== false }), debug, options }
    const run = (fn: () => Promise<void>) => void fn().catch((e) => context.ui.toast.show({ title: "openbot", message: String(e?.message ?? e), variant: "error" }))

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "openbot.create", title: "Create bot", group: "openbot", palette: true, suggested: true, slash: { name: "bot-new" }, run: () => run(() => createBotFlow(deps)) },
        { id: "openbot.bots", title: "Bots: inspect, edit, conversations", group: "openbot", palette: true, slash: { name: "bots" }, run: () => run(() => botsFlow(deps)) },
        ...(debug
          ? [
              { id: "openbot.diagnose", title: "Bots: diagnose", group: "openbot", palette: true as const, slash: { name: "bots-diagnose" }, run: () => run(() => diagnoseFlow(deps, undefined, false)) },
              { id: "openbot.report", title: "Bots: generate diagnostic report", group: "openbot", palette: true as const, slash: { name: "bots-report" }, run: () => run(() => diagnoseFlow(deps, undefined, true)) },
            ]
          : []),
      ],
    }))

    const unslot = context.ui.slot({
      append: "sidebar.content",
      render: () => <BotsSidebar store={store} muted={context.theme.text.muted} open={(name) => run(() => botMenuFlow(deps, name))} />,
    })
    return () => unslot()
  },
}

export default plugin
