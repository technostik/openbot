/** @jsxImportSource @opentui/solid */
/**
 * openbot, terminal side: Ctrl+P commands, a Bots list in the session sidebar
 * (with status, alerts and pending questions), the bot inspector, and the
 * watcher that notifies you when a bot needs you. Loaded by the opencode TUI
 * from the package's `./tui` export (TSX source, transpiled by the host).
 * All logic lives in flows.ts.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { debugEnabled } from "../dist/debug/enabled.js"
import { botMenuFlow, botsFlow, createBotFlow, diagnoseFlow, fieldText, inboxFlow, pendingQuestions, type FlowDeps } from "../dist/flows.js"
import { openItems, updateInboxItem } from "../dist/inbox.js"
import { resolveRoot } from "../dist/paths.js"
import { makeService } from "../dist/service.js"
import { BotStore } from "../dist/store.js"
import { showViewer } from "./viewer.js"

interface Row {
  name: string
  model: string
  status: string
  alerts: number
  questions: number
  items: { id: string; title: string; level: string }[]
}

function BotsSidebar(props: {
  rows: () => Row[]
  muted: any
  open: (name: string) => void
  openItem: (name: string, id: string) => void
}) {
  const [botsOpen, setBotsOpen] = createSignal(true)
  const [folded, setFolded] = createSignal<Record<string, boolean>>({})
  const toggle = (name: string) => setFolded((f) => ({ ...f, [name]: !f[name] }))
  const totalAlerts = () => props.rows().reduce((n, b) => n + b.alerts, 0)
  return (
    <box flexDirection="column" paddingTop={1}>
      <box onMouseUp={() => setBotsOpen((v) => !v)}>
        <text fg={props.muted}>{`${botsOpen() ? "▾" : "▸"} Bots (${props.rows().length})${totalAlerts() ? ` - Alerts : ${totalAlerts()}` : ""}`}</text>
      </box>
      <Show when={botsOpen() && !props.rows().length}>
        <text fg={props.muted}>none yet: Ctrl+P, Create bot</text>
      </Show>
      <Show when={botsOpen() && props.rows().length}>
        <For each={props.rows()}>
          {(b) => (
            <box flexDirection="column">
              <box flexDirection="row">
                <box onMouseUp={() => toggle(b.name)}>
                  <text fg="#000000">{folded()[b.name] ? "▸" : "▾"}</text>
                </box>
                <box onMouseUp={() => props.open(b.name)}>
                  <text fg="#000000">{`@${b.name}`}</text>
                </box>
                <text fg="#000000">{`${b.alerts ? `  !${b.alerts}` : ""}${b.questions ? `  ?${b.questions}` : ""}`}</text>
              </box>
              <Show when={!folded()[b.name] && b.items.length}>
                <box flexDirection="column" paddingLeft={3}>
                  <For each={b.items}>
                    {(it) => (
                      <box onMouseUp={() => props.openItem(b.name, it.id)}>
                        <text fg={props.muted}>{`${it.level === "attention" ? "!" : "-"} ${it.title}`}</text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

/** Alert detail dialog: the full message plus Close (keeps it unread) and Mark as Read. */
function AlertDialog(props: {
  title: string
  message: string
  at: string
  level: string
  muted: any
  onClose: () => void
  onRead: () => void
}) {
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg="#000000">{`${props.level === "attention" ? "! " : ""}${props.title}`}</text>
      <scrollbox height={16}>
        <text fg="#000000">{props.message}</text>
      </scrollbox>
      <text fg="#555555">{props.at}</text>
      <box flexDirection="row" paddingTop={1}>
        <box bg="#d0d0d0" paddingLeft={2} paddingRight={2} onMouseUp={props.onClose}>
          <text fg="#000000">Close</text>
        </box>
        <box bg="#d0d0d0" paddingLeft={2} paddingRight={2} onMouseUp={props.onRead}>
          <text fg="#000000">Mark as Read</text>
        </box>
      </box>
    </box>
  )
}

const plugin: Plugin.Definition = {
  id: "openbot",
  setup(context) {
    const options = (context.options ?? {}) as Record<string, unknown>
    const store = new BotStore(resolveRoot(options))
    const debug = debugEnabled(options)
    const deps: FlowDeps = {
      ctx: context,
      store,
      service: makeService(store, { materialize: options.materialize !== false }),
      debug,
      options,
      viewer: (title, text) => showViewer(context, title, text),
    }
    const run = (fn: () => Promise<unknown>) => void fn().catch((e) => context.ui.toast.show({ title: "openbot", message: String(e?.message ?? e), variant: "error" }))

    const [rows, setRows] = createSignal<Row[]>([])
    const seenAlerts = new Set<string>()
    const seenQuestions = new Set<string>()
    let primed = false
    const bell = options.bell !== false

    const alert = (title: string, message: string, sound: "question" | "default", sessionID?: string) => {
      context.ui.toast.show({ title, message, variant: "warning", duration: 12000, sessionID })
      void context.attention.notify({ title, message, notification: true, sound: { name: sound } }).catch(() => {})
      if (bell) process.stdout.write("\x07")
    }

    const tick = async () => {
      const bots = store.list()
      const questions = await pendingQuestions(deps).catch(() => [])
      let waitingAtStart = 0
      for (const b of bots) {
        for (const it of openItems(store, b.name)) {
          if (seenAlerts.has(it.id)) continue
          seenAlerts.add(it.id)
          if (!primed) waitingAtStart++
          else if (it.level === "attention") alert(`@${b.name}: ${it.title ?? "needs your attention"}`, it.message.slice(0, 240), "question", it.sessionID)
          else context.ui.toast.show({ title: `@${b.name}: ${it.title ?? "note"}`, message: it.message.slice(0, 240), variant: "info", duration: 8000, sessionID: it.sessionID })
        }
      }
      for (const q of questions) {
        if (seenQuestions.has(q.formID)) continue
        seenQuestions.add(q.formID)
        if (primed) alert(`@${q.bot} is asking you`, fieldText(q.fields[0] ?? {}).slice(0, 240), "question", q.sessionID)
        else waitingAtStart++
      }
      if (!primed) {
        primed = true
        if (waitingAtStart) context.ui.toast.show({ title: "openbot", message: `${waitingAtStart} thing(s) waiting for you: Ctrl+P, Bots: inbox`, variant: "warning", duration: 10000 })
      }
      setRows(
        bots.map((b) => {
          const items = openItems(store, b.name)
          return {
            name: b.name,
            model: b.model ?? "default model",
            status: b.status ?? "active",
            alerts: items.length,
            questions: questions.filter((q) => q.bot === b.name).length,
            items: items.map((it) => ({ id: it.id, title: it.title ?? it.message.slice(0, 48), level: it.level })),
          }
        }),
      )
    }
    setRows(store.list().map((b) => ({ name: b.name, model: b.model ?? "default model", status: b.status ?? "active", alerts: 0, questions: 0, items: [] })))
    void tick().catch(() => {})
    const timer = setInterval(() => void tick().catch(() => {}), 2500)

    // Sidebar second level: click an alert to open its dialog (Close keeps it unread, Mark as Read clears it).
    const openItem = (name: string, id: string) => {
      const it = openItems(store, name).find((x) => x.id === id)
      if (!it) return
      let done = false
      const close = () => {
        if (done) return
        done = true
        context.ui.dialog.clear()
        void tick().catch(() => {})
      }
      const size = it.message.length > 800 ? "xlarge" : it.message.length > 240 ? "large" : "medium"
      context.ui.dialog.set({ size })
      context.ui.dialog.show(
        () => (
          <AlertDialog
            title={it.title ?? `@${name}`}
            message={it.message}
            at={it.at}
            level={it.level}
            muted={context.theme.text.muted}
            onClose={close}
            onRead={() => {
              updateInboxItem(store, name, id, { status: "read" })
              close()
            }}
          />
        ),
        () => close(),
      )
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "openbot.create", title: "Create bot", group: "openbot", palette: true, suggested: true, slash: { name: "bot-new" }, run: () => run(() => createBotFlow(deps)) },
        { id: "openbot.bots", title: "Bots: inspect, edit, conversations", group: "openbot", palette: true, slash: { name: "bots" }, run: () => run(() => botsFlow(deps)) },
        { id: "openbot.inbox", title: "Bots: inbox (alerts and questions)", group: "openbot", palette: true, slash: { name: "bot-inbox" }, run: () => run(() => inboxFlow(deps)) },
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
      render: () => <BotsSidebar rows={rows} muted={context.theme.text.muted} open={(name) => run(() => botMenuFlow(deps, name))} openItem={openItem} />,
    })
    return () => {
      clearInterval(timer)
      unslot()
    }
  },
}

export default plugin
