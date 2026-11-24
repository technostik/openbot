// Scripted OpenAI-compatible chat/completions server for offline plugin tests.
// Primary requests consume the first queued step whose `when(request)` matches (or any step without `when`);
// requests that follow a tool result get an automatic text answer echoing that result.
import http from "node:http"

export async function startMock(port) {
  const queue = []
  const requests = []
  let n = 0
  const sse = (res, chunks) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  }
  const chunk = (delta, finish) => ({ id: "m" + n, object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })
  const usage = () => ({ id: "m" + n, object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
  const asText = (c) => (typeof c === "string" ? c : JSON.stringify(c))

  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (d) => (body += d))
    req.on("end", () => {
      if (!req.url.includes("/chat/completions")) { res.writeHead(404); return res.end("{}") }
      const j = JSON.parse(body || "{}")
      const messages = j.messages ?? []
      const system = messages.filter((m) => m.role === "system").map((m) => asText(m.content)).join("\n")
      const tools = (j.tools ?? []).map((t) => t.function?.name)
      const aux = /name conversations|title for it/i.test(system) || (tools.length === 0 && /summar/i.test(system))
      const last = [...messages].reverse().find((m) => m.role === "user" || m.role === "tool")
      const lastText = last ? asText(last.content) : ""
      const afterTool = last?.role === "tool"
      const rec = { n: ++n, aux, system, tools, toolDefs: j.tools ?? [], messages, lastText, afterTool }
      requests.push(rec)
      if (aux) return sse(res, [chunk({ role: "assistant", content: "Mock title" }), chunk({}, "stop"), usage()])
      if (afterTool) return sse(res, [chunk({ role: "assistant", content: "after-tool: " + lastText.slice(0, 600) }), chunk({}, "stop"), usage()])
      const i = queue.findIndex((s) => !s.when || s.when(rec))
      const step = i >= 0 ? queue.splice(i, 1)[0] : { text: "mock-echo: " + lastText.slice(0, 300) }
      rec.step = step
      if (step.tool) {
        return sse(res, [
          chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_" + n, type: "function", function: { name: step.tool, arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args ?? {}) } }] }),
          chunk({}, "tool_calls"), usage(),
        ])
      }
      sse(res, [chunk({ role: "assistant", content: step.text }), chunk({}, "stop"), usage()])
    })
  })
  await new Promise((r) => server.listen(port, "127.0.0.1", r))
  return { url: `http://127.0.0.1:${port}/v1`, queue, requests, close: () => new Promise((r) => server.close(r)) }
}
