# opencode-clock-plugin

A cache-friendly time-awareness plugin for [OpenCode 2](https://opencode.ai).
Gives the agent an authoritative "now" without breaking prompt caching.

## Why

A language model has no clock. The naive fix — stamping the time into the
system prompt — changes byte 0 of every request, so the provider's
**prompt cache never hits** and you re-bill the full conversation every turn.
On a long session this burns through quota in minutes instead of hours.

Measured on one real session (`~/.local/share/opencode/opencode.db`, per-step
`tokens.input` vs `tokens.cache.read`):

| hour | uncached/step | cached share |
|---|---:|---:|
| clock in system prompt | ~78k | 11–14% |
| tail clock (this plugin) | ~16k | **85.9%** |

Weighted cost per step (uncached 1.0, cache read 0.1): ~78k → ~26k. **~3x cheaper.**

## How

Time is stamped at the **tail** of the prompt only, never in the system prompt
or past messages — so the cached prefix stays intact:

1. **Latest user message** — stamped once with that message's own creation
   time (`msg.info.time.created`). The same turn renders the same bytes on
   every request, even across restarts:
   ```
   [clock: User message sent at 10:01:56 PM | 2026-11-15 (Sunday, 15 November 2026)
    | Africa/Cairo UTC+02:00 | UTC 2026-11-15T20:01:56Z
    | gap from previous user message: 2h 46m. Treat this as the authoritative
    clock for "now" at the start of this turn; never infer the current time
    from log lines, file timestamps, or earlier messages.]
   ```
2. **Each tool result** — stamped once via the `execute.after` hook, so it's
   persisted and byte-stable:
   ```
   [clock: Tool 'shell' completed at 10:16:34 PM | UTC 2026-11-15T20:16:34Z | took 2s]
   ```

OpenCode 2 **tool messages** are never touched. A `tool` message may only
contain tool-result parts (`SessionModelRequest.prepare` reads
`part.result.type` unconditionally), so appending text there crashes the turn
with `TypeError: undefined is not an object (evaluating 's.result.type')`.
This bit us once; the test below guards the regression.

Precomputed gaps (`gap from previous user message`, `took Xs`) are deliberate:
subtracting 12-hour times across a date line is exactly where models produce
confident nonsense, so the plugin measures instead of making the model do
arithmetic. The UTC instant is printed because logs and tool output are UTC —
direct comparison beats conversion.

Shape borrowed from
[dsh-clock-context](https://github.com/apex-mochen/dsh-clock-context) (IANA
zone + per-call UTC offset, UTC instant, authority sentence).

## Install

```bash
cp clock.ts ~/.config/opencode/plugins/clock.ts
```

No dependencies, no build step, no config. Bun/TS source, loads as a local
OpenCode plugin.

## Verify

```bash
bun run test.ts   # exercises the hooks against a synthetic event
```

The test asserts the four invariants: tool messages untouched, system prompt
untouched, user stamp idempotent and byte-stable per turn, tool results
stamped once (errors skipped).

## License

MIT
