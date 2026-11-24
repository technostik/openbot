// Minimal stdio MCP server (newline-delimited JSON-RPC) exposing one tool: echo.
import readline from "node:readline"
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "1.0.0" } } })
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } })
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "mcp-echo:" + (m.params?.arguments?.text ?? "") }] } })
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })
})
