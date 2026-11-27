/** @jsxImportSource @opentui/solid */
/** A scrollable full-text viewer in a dialog (the stock alert only shows the first lines). */
import type { Plugin } from "@opencode/plugin/tui"
import { useKeyboard } from "@opentui/solid"

function Viewer(props: { title: string; text: string; muted: any }) {
  let box: any
  useKeyboard((e) => {
    if (!box) return
    const page = Math.max(5, (box.viewport?.height ?? 20) - 2)
    if (e.name === "down" || e.name === "j") box.scrollBy(1)
    else if (e.name === "up" || e.name === "k") box.scrollBy(-1)
    else if (e.name === "pagedown" || e.name === "space") box.scrollBy(page)
    else if (e.name === "pageup" || e.name === "b") box.scrollBy(-page)
    else if (e.name === "home" || (e.name === "g" && !e.shift)) box.scrollTo(0)
    else if (e.name === "end" || (e.name === "g" && e.shift)) box.scrollTo(box.scrollHeight)
  })
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text>{props.title}</text>
      <scrollbox ref={(el: any) => (box = el)} focused height={24}>
        <text>{props.text}</text>
      </scrollbox>
      <text fg={props.muted}>{"Up/Down or j/k: line. Space/b or PgDn/PgUp: page. g/G or Home/End: top/bottom. Esc: close."}</text>
    </box>
  )
}

export function showViewer(ctx: Plugin.Context, title: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    ctx.ui.dialog.set({ size: "xlarge" })
    ctx.ui.dialog.show(() => <Viewer title={title} text={text} muted={ctx.theme.text.muted} />, () => resolve())
  })
}
