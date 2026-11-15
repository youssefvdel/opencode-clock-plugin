// Cache-friendly Clock Plugin for OpenCode 2
// Stamps time at the TAIL of the prompt only, never in the system prompt:
//   1. the latest user message, using that message's own creation time so
//      every request for the same turn carries identical bytes;
//   2. each tool result, once, when the tool finishes.
// Tool *messages* are never touched: OpenCode 2 allows only tool-result parts
// inside them, and SessionModelRequest.prepare reads `part.result.type`
// unconditionally, so appending text there crashes the turn.
// Shape borrowed from dsh-clock-context: IANA zone + per-call UTC offset, the
// UTC instant (logs are UTC), and a sentence making the value authoritative so
// the model never guesses "now" from file mtimes or old log lines.

const MARKER = "[clock:"
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTH = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function clock12(now: Date): string {
  const hours = now.getHours() % 12 || 12
  return `${hours}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${now.getHours() < 12 ? "AM" : "PM"}`
}

function dateStamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function zone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
  } catch {
    return "local"
  }
}

// UTC offset at this instant, so the model can do arithmetic without knowing
// DST rules. Computed per call, the way dsh-clock-context does it.
function zoneOffset(now: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone(),
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(now)
    const bag: Record<string, string> = {}
    for (const part of parts) bag[part.type] = part.value
    const asUtc = Date.UTC(
      Number(bag.year),
      Number(bag.month) - 1,
      Number(bag.day),
      Number(bag.hour) % 24,
      Number(bag.minute),
      Number(bag.second),
    )
    const drift = asUtc - (now.getTime() - (now.getTime() % 1000))
    const total = Math.round(drift / 60000)
    const abs = Math.abs(total)
    return `UTC${total < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  } catch {
    return null
  }
}

// Logs and tool output are usually UTC; printing the UTC instant lets the model
// compare directly instead of converting.
function utcStamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z")
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return "<1s"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${pad(rm)}m` : `${h}h`
}

function formatUserClock(now: Date, previous?: number): string {
  const dated = `${WEEKDAY[now.getDay()]}, ${now.getDate()} ${MONTH[now.getMonth()]} ${now.getFullYear()}`
  const zoneBits = [zone(), zoneOffset(now)].filter(Boolean).join(" ")
  // The gap is between two fixed instants, so it renders identically on every
  // request and costs nothing in cache terms. It saves the model from doing
  // 12-hour-clock arithmetic to notice that an hour passed.
  const gap = typeof previous === "number" ? humanDuration(now.getTime() - previous) : ""
  const gapBits = gap ? ` | gap from previous user message: ${gap}` : ""
  return `\n\n${MARKER} User message sent at ${clock12(now)} | ${dateStamp(now)} (${dated}) | ${zoneBits} | UTC ${utcStamp(now)}${gapBits}. Treat this as the authoritative clock for "now" at the start of this turn; never infer the current time from log lines, file timestamps, or earlier messages.]`
}

function formatToolClock(now: Date, toolName?: string, durationMs?: number): string {
  const label = toolName ? `Tool '${toolName}' completed` : "Tool completed"
  const took = typeof durationMs === "number" ? humanDuration(durationMs) : ""
  const tookBits = took ? ` | took ${took}` : ""
  return `\n${MARKER} ${label} at ${clock12(now)} | UTC ${utcStamp(now)}${tookBits}]`
}

function hasMarker(parts: any[]): boolean {
  return parts.some((p: any) => {
    const text = p?.type === "text" ? p.text : typeof p === "string" ? p : p?.content
    return typeof text === "string" && text.includes(MARKER)
  })
}

function stampUserMessage(event: any, now: Date): void {
  try {
    const messages = Array.isArray(event?.messages) ? event.messages : []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const role = msg?.info?.role || msg?.role
      if (role !== "user") continue
      const parts = Array.isArray(msg.content) ? msg.content : Array.isArray(msg.parts) ? msg.parts : null
      if (!parts || parts.length === 0) return
      if (hasMarker(parts)) return
      // The send time is fixed per message, so the same turn renders the same
      // bytes on every request and the prompt prefix stays cacheable.
      const created = msg?.info?.time?.created
      const sent = typeof created === "number" ? new Date(created) : now
      let previous: number | undefined
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j]
        if ((prev?.info?.role || prev?.role) !== "user") continue
        const t = prev?.info?.time?.created
        if (typeof t === "number") previous = t
        break
      }
      parts.push({ type: "text", text: formatUserClock(sent, previous) })
      return
    }
  } catch {
    // best-effort
  }
}

async function setup(ctx: {
  session?: { hook: (name: string, handler: (event: any) => void) => Promise<unknown> }
  tool?: { hook: (name: string, handler: (event: any) => void) => Promise<unknown> }
}): Promise<() => void> {
  const disposers: (() => void)[] = []
  // Start times per tool call, so the result can report how long it took. A
  // model has no sense of duration unless someone measures it.
  const starts = new Map<string, number>()

  // Stamp the tool result once, as it completes. Result content is stored, so
  // the bytes never change afterwards.
  if (ctx.tool && typeof ctx.tool.hook === "function") {
    try {
      const beforeReg: any = await ctx.tool.hook("execute.before", (event: any) => {
        try {
          const key = `${event?.sessionID}:${event?.id}`
          if (!event?.id) return
          starts.set(key, Date.now())
          if (starts.size > 256) starts.delete(starts.keys().next().value as string)
        } catch {
          // ignore
        }
      })
      if (beforeReg?.dispose) disposers.push(() => beforeReg.dispose())

      const toolReg: any = await ctx.tool.hook("execute.after", async (event: any) => {
        try {
          const key = `${event?.sessionID}:${event?.id}`
          const started = starts.get(key)
          starts.delete(key)
          if (event?.status === "error" || !event?.result) return
          const stamp = formatToolClock(new Date(), event?.tool, started ? Date.now() - started : undefined)
          if (typeof event.result.output === "string") {
            if (!event.result.output.includes(MARKER)) event.result.output += stamp
          } else if (Array.isArray(event.result.content)) {
            if (!hasMarker(event.result.content)) {
              event.result.content.push({ type: "text", text: stamp })
            }
          }
        } catch {
          // ignore
        }
      })
      if (toolReg?.dispose) disposers.push(() => toolReg.dispose())
    } catch {
      // ignore
    }
  }

  // Stamp only the latest user message, at the tail. Never event.system, never
  // tool messages.
  if (ctx.session && typeof ctx.session.hook === "function") {
    try {
      const contextReg: any = await ctx.session.hook("context", (event: any) => {
        stampUserMessage(event, new Date())
      })
      if (contextReg?.dispose) disposers.push(() => contextReg.dispose())
    } catch {
      // ignore
    }
  }

  return () => {
    for (const d of disposers) d()
  }
}

export default { id: "clock", setup }
