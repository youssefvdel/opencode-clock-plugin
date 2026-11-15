import plugin from "./clock.ts"

const hooks: Record<string, Function> = {}
const ctx = {
  session: { hook: async (name: string, fn: Function) => { hooks[name] = fn; return { dispose() {} } } },
  tool: { hook: async (name: string, fn: Function) => { hooks[name] = fn; return { dispose() {} } } },
}
await (plugin as any).setup(ctx)

const fail: string[] = []
const ok = (cond: boolean, msg: string) => { if (!cond) fail.push(msg) }

// 1. tool message must stay untouched (this is what crashed prepare)
const toolMsg = { role: "tool", content: [{ type: "tool-result", id: "t1", name: "shell", result: { type: "content", value: [] } }] }
const older = { role: "user", info: { role: "user", time: { created: 1794762916443 } }, content: [{ type: "text", text: "earlier" }] }
const userMsg = { role: "user", info: { role: "user", time: { created: 1794772916443 } }, content: [{ type: "text", text: "hello" }] }
const event: any = { system: [{ type: "text", text: "SYS" }], messages: [older, userMsg, toolMsg] }
const beforeTool = JSON.stringify(toolMsg.content)
const beforeSystem = JSON.stringify(event.system)

await hooks["context"](event)
ok(JSON.stringify(toolMsg.content) === beforeTool, "tool message was mutated")
ok(JSON.stringify(event.system) === beforeSystem, "system prompt was mutated")
ok(userMsg.content.length === 2 && userMsg.content[1].text.includes("[clock:"), "user message not stamped")

// 2. same bytes on every request of the same turn (cache stability)
const first = userMsg.content[1].text
await hooks["context"](event)
ok(userMsg.content.length === 2, "user message stamped twice")
ok(userMsg.content[1].text === first, "user stamp changed between requests")
ok(first.includes("10:01:56 PM"), `stamp not derived from time.created: ${first.trim()}`)
ok(first.includes("gap from previous user message: 2h 46m"), `missing gap: ${first.trim()}`)
ok(first.includes("UTC 2026-11-15T20:01:56Z"), "missing UTC instant")
ok(first.includes("Africa/Cairo UTC+02:00"), "missing zone offset")
ok(first.includes("authoritative clock"), "missing authority hint")

// 3. tool result: appended once, duration measured, skipped on error
const call: any = { sessionID: "s1", id: "call1", tool: "shell" }
await hooks["execute.before"](call)
await new Promise((r) => setTimeout(r, 40))
const res: any = { ...call, status: "completed", result: { output: "line1" } }
await hooks["execute.after"](res)
await hooks["execute.after"](res)
ok((res.result.output.match(/\[clock:/g) || []).length === 1, "tool output stamped twice")
ok(/took (<1s|\d+m?s)/.test(res.result.output), `missing duration: ${res.result.output}`)
ok(res.result.output.includes("UTC "), "missing UTC on tool stamp")
const err: any = { sessionID: "s1", id: "call2", status: "error", tool: "shell", error: { message: "x" } }
await hooks["execute.after"](err)
ok(JSON.stringify(err).includes("[clock:") === false, "error event was stamped")

// 4. content-array results stamped once
const res2: any = { sessionID: "s2", id: "call3", status: "completed", tool: "read", result: { content: [{ type: "text", text: "body" }] } }
await hooks["execute.after"](res2)
await hooks["execute.after"](res2)
ok(res2.result.content.length === 2, `content result grew to ${res2.result.content.length}`)

console.log(fail.length === 0 ? "PASS all clock invariants" : "FAIL:\n- " + fail.join("\n- "))
console.log("user stamp:", first.trim())
console.log("tool stamp:", res.result.output.split("\n").pop())
