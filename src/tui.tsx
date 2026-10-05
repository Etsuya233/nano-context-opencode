/** @jsxImportSource @opentui/solid */
import { appendFileSync } from "node:fs"
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { LayoutEvents, type BoxRenderable, type RGBA } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"

import { allocateSegments, EMPTY, FILLED, formatMoney, formatTokens, type Bucket } from "./bar.ts"

/**
 * nano-context-opencode
 *
 * A segmented ("noodle") token meter for the OpenCode session sidebar.
 *
 * Segments are the token buckets OpenCode records on the current turn's
 * assistant message, plus whatever room is left in the model's context window:
 *
 *   in     uncached prompt tokens
 *   cache  cache read + cache write tokens
 *   think  reasoning tokens
 *   out    visible output tokens
 *   free   the remainder of the model's context window
 *
 * Every number comes from `message.tokens` / `message.cost`. Nothing is
 * re-tokenized, so nothing here is an estimate except `out` while a reply is
 * still streaming.
 */

const ID = "nano-context-opencode"

/** Rough characters-per-token, used only for the in-flight streaming estimate. */
const CHARS_PER_TOKEN = 4

type Scope = "turn" | "session"

/** `"auto"` fills the sidebar; a number pins an exact cell count. */
type BarWidth = "auto" | number

type Config = {
  label: string
  barWidth: BarWidth
  showReasoning: boolean
  showCost: boolean
  showTotal: boolean
  estimateStreaming: boolean
  estimateReasoning: boolean
  scope: Scope
}

const DEFAULTS: Config = {
  label: "Context",
  barWidth: "auto",
  showReasoning: true,
  showCost: true,
  showTotal: true,
  estimateStreaming: true,
  estimateReasoning: false,
  scope: "turn",
}

/** Used until the measured width is known, and if the host never lays the box out. */
const FALLBACK_BAR_WIDTH = 37
const MIN_BAR_WIDTH = 8
const MAX_BAR_WIDTH = 200

type Usage = {
  input: number
  cache: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  reasoningEstimated: boolean
  output: number
  used: number
  prompt: number
  cacheHit: number
}

type Segment = { key: string; color: RGBA; cells: number }

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function readLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  return value === "" ? " " : value
}

function readScope(value: unknown): Scope {
  return value === "session" ? "session" : "turn"
}

function readBarWidth(value: unknown): BarWidth {
  if (value === "auto") return "auto"
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULTS.barWidth
  return Math.round(Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, parsed)))
}

/** A measured box reports 0 until it has been laid out; keep the fallback then. */
function normalizeWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return FALLBACK_BAR_WIDTH
  return Math.round(Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, width)))
}

function readConfig(options: Record<string, any> | undefined): Config {
  const input = options ?? {}
  return {
    label: readLabel(input.label, DEFAULTS.label),
    barWidth: readBarWidth(input.barWidth),
    showReasoning: readBoolean(input.showReasoning, DEFAULTS.showReasoning),
    showCost: readBoolean(input.showCost, DEFAULTS.showCost),
    showTotal: readBoolean(input.showTotal, DEFAULTS.showTotal),
    estimateStreaming: readBoolean(input.estimateStreaming, DEFAULTS.estimateStreaming),
    estimateReasoning: readBoolean(input.estimateReasoning, DEFAULTS.estimateReasoning),
    scope: readScope(input.scope),
  }
}

function positive(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return value > 0 ? value : 0
}

/** Narrow an unknown message to an assistant message without importing client types. */
function isAssistant(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "assistant"
}

/** Turn one assistant message's recorded tokens into the numbers the panel shows. */
function usageFor(message: any, config: Config, streaming = 0): Usage | undefined {
  if (!message) return undefined

  const tokens = message.tokens ?? {}
  const cacheRead = positive(tokens.cache?.read)
  const cacheWrite = positive(tokens.cache?.write)
  const cache = cacheRead + cacheWrite
  const input = positive(tokens.input)
  const recorded = positive(tokens.reasoning)

  // Some providers report reasoning inside `output` and leave `reasoning` at 0.
  // Estimate it from the reasoning blocks the turn actually stored, and flag it
  // so the row can say so rather than quietly inventing a number.
  let reasoning = recorded
  let reasoningEstimated = false
  if (reasoning === 0 && config.estimateReasoning) {
    let characters = 0
    for (const part of message.content ?? []) {
      if (part?.type === "reasoning" && typeof part.text === "string") characters += part.text.length
    }
    if (characters > 0) {
      reasoning = Math.round(characters / CHARS_PER_TOKEN)
      reasoningEstimated = true
    }
  }

  // Folding reasoning into `out` when the segment is hidden keeps the bar honest.
  const output = positive(tokens.output) + (config.showReasoning ? 0 : reasoning) + streaming

  // The prompt is the only thing a cache can ever apply to, so it is the
  // denominator for the hit rate.
  const prompt = input + cache

  return {
    input,
    cache,
    cacheRead,
    cacheWrite,
    reasoning,
    reasoningEstimated,
    output,
    used: input + output + reasoning + cache,
    prompt,
    cacheHit: prompt > 0 ? (cacheRead / prompt) * 100 : 0,
  }
}

/**
 * Sum every assistant step in the session.
 *
 * This is cumulative spend, not live context: twenty steps of a cached
 * conversation can total several times the model's context window, so this
 * number is only meaningful as "how much has this session consumed". It drives
 * the rows, never the window bar.
 */
function sessionUsageFor(messages: ReadonlyArray<any>, config: Config): Usage | undefined {
  let total: Usage | undefined
  for (const message of messages) {
    if (!isAssistant(message) || !message.tokens) continue
    const step = usageFor(message, config)
    if (!step) continue
    if (!total) {
      total = { ...step }
      continue
    }
    total.input += step.input
    total.cache += step.cache
    total.cacheRead += step.cacheRead
    total.cacheWrite += step.cacheWrite
    total.reasoning += step.reasoning
    total.reasoningEstimated ||= step.reasoningEstimated
    total.output += step.output
    total.used += step.used
    total.prompt += step.prompt
  }
  if (total) total.cacheHit = total.prompt > 0 ? (total.cacheRead / total.prompt) * 100 : 0
  return total
}

type Theme = Plugin.Context["theme"]

function Row(props: {
  theme: Accessor<Theme>
  label: string
  value: string
  color: RGBA
  suffix?: string
}) {
  const theme = () => props.theme()
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.color} wrapMode="none">
        {props.label}
      </text>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme().text.base} wrapMode="none">
          {props.value}
        </text>
        <Show when={props.suffix}>
          <text fg={theme().text.muted} wrapMode="none">
            {props.suffix}
          </text>
        </Show>
      </box>
    </box>
  )
}

function Panel(props: { context: Plugin.Context; sessionID: string; config: Config }) {
  const context = props.context
  const config = props.config
  const theme = () => context.theme

  /**
   * The bar is drawn with block glyphs, so its length has to be decided in cells
   * — flexbox cannot stretch a run of text for us. Measure the slot's own box
   * instead of assuming the sidebar width, and follow layout changes so a
   * terminal resize does not leave a stale bar.
   */
  const [available, setAvailable] = createSignal(FALLBACK_BAR_WIDTH)
  let measured: BoxRenderable | undefined
  const track = (box: BoxRenderable | undefined) => {
    measured = box
    if (box) setAvailable(normalizeWidth(box.width))
  }
  onMount(() => {
    if (!measured) return
    const onResize = () => setAvailable(normalizeWidth(measured!.width))
    measured.on(LayoutEvents.RESIZED, onResize)
    onCleanup(() => measured?.off(LayoutEvents.RESIZED, onResize))
  })
  onCleanup(() => {
    measured = undefined
  })
  const barWidth = createMemo(() =>
    config.barWidth === "auto" ? available() : (config.barWidth as number),
  )

  const colors = createMemo(() => {
    const t = theme()
    return {
      in: t.hue.interactive[500],
      cache: t.hue.accent[500],
      think: t.text.feedback.warning.base,
      out: t.text.feedback.success.base,
      free: t.text.muted,
    }
  })

  /**
   * The newest assistant message that has produced output is the one whose
   * numbers describe the current turn.
   */
  const anchor = createMemo(() => {
    const messages = context.data.session.message.list(props.sessionID) ?? []
    const assistants = messages.filter(isAssistant)
    return assistants.findLast((m: any) => positive(m.tokens?.output) > 0) ?? assistants.at(-1)
  })

  /**
   * While a reply streams the provider has not reported usage yet, so approximate
   * the visible output from the text accumulated so far. OpenCode replaces this
   * with exact figures when it records `time.completed`.
   */
  const streamingOutput = createMemo(() => {
    if (!config.estimateStreaming) return 0
    const message = anchor() as any
    if (!message || message.time?.completed) return 0
    let characters = 0
    for (const part of message.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string") characters += part.text.length
    }
    return characters === 0 ? 0 : Math.round(characters / CHARS_PER_TOKEN)
  })

  /**
   * What is resident in the model's context window right now. Always the last
   * step, whatever `scope` says, because the window only ever holds one step's
   * prompt.
   */
  const live = createMemo<Usage | undefined>(() => usageFor(anchor(), config, streamingOutput()))

  /** What the rows report: this step, or every step in the session. */
  const usage = createMemo<Usage | undefined>(() => {
    if (config.scope === "turn") return live()
    return sessionUsageFor(context.data.session.message.list(props.sessionID) ?? [], config)
  })

  const limit = createMemo<number | undefined>(() => {
    const message = anchor() as any
    const ref = message?.model
    if (!ref?.providerID || !ref?.id) return undefined
    const location = context.location ?? context.data.location.default()
    const models = context.data.location.model.list(location) ?? []
    // A message's ModelRef carries `id`; ModelInfo exposes both `id` and
    // `modelID`, and the built-in Context panel matches on `id`.
    const found = models.find((model) => model.providerID === ref.providerID && model.id === ref.id)
    const size = found?.limit?.context
    return typeof size === "number" && size > 0 ? size : undefined
  })

  const percent = createMemo<number | undefined>(() => {
    const current = live()
    const maximum = limit()
    if (!current || !maximum) return undefined
    return Math.min(100, Math.round((current.used / maximum) * 100))
  })

  const cost = createMemo<number>(() => {
    const session = context.data.session.get(props.sessionID)
    const sessionCost = positive(session?.cost)
    if (sessionCost > 0) return sessionCost
    return positive(context.data.session.cost(props.sessionID))
  })

  const segments = createMemo<Segment[]>(() => {
    const current = live()
    if (!current) return []
    const palette = colors()

    const maximum = limit()
    // Scale against the real window so `free` means something. When the turn
    // overflows the window, scale against the usage instead and fill the bar.
    const denominator = maximum !== undefined && current.used < maximum ? maximum : Math.max(current.used, 1)

    const buckets: Array<Bucket<RGBA>> = [
      { key: "in", color: palette.in, value: current.input },
      { key: "cache", color: palette.cache, value: current.cache },
    ]
    if (config.showReasoning) buckets.push({ key: "think", color: palette.think, value: current.reasoning })
    buckets.push({ key: "out", color: palette.out, value: current.output })

    return allocateSegments(buckets, denominator, barWidth()).map((segment) =>
      segment.key === "free" ? { ...segment, color: palette.free } : segment,
    )
  })

  return (
    <Show when={usage()}>
      {(current: Accessor<Usage>) => {
        const palette = colors()
        return (
          <box flexDirection="column" width="100%" ref={track}>
            <text fg={theme().text.base}>
              <b>{config.label}</b>
            </text>

            <text wrapMode="none">
              <For each={segments()}>
                {(segment) => (
                  <span style={{ fg: segment.color }}>
                    {(segment.key === "free" ? EMPTY : FILLED).repeat(segment.cells)}
                  </span>
                )}
              </For>
            </text>

            {/*
             * Two different totals, so they must never share a line. In `turn`
             * scope the window line *is* the row sum, so it stands alone. In
             * `session` scope the rows sum to something else entirely, and the
             * window gets its own labelled line so the two cannot be confused.
             */}
            <Show
              when={config.showTotal || (config.showCost && cost() > 0)}
              fallback={
                <Show when={config.showCost && cost() > 0}>
                  <text fg={theme().text.muted} wrapMode="none">
                    {formatMoney(cost())}
                  </text>
                </Show>
              }
            >
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme().text.muted} wrapMode="none">
                  {config.scope === "session" ? "window  " : ""}
                  {config.showTotal
                    ? limit()
                      ? `${formatTokens(live()?.used ?? current().used)} / ${formatTokens(limit()!)} (${percent() ?? 0}%)`
                      : formatTokens(live()?.used ?? current().used)
                    : " "}
                </text>
                <Show when={config.scope !== "session" && config.showCost && cost() > 0}>
                  <text fg={theme().text.muted} wrapMode="none">
                    {formatMoney(cost())}
                  </text>
                </Show>
              </box>
            </Show>

            <Row theme={theme} label="in" color={palette.in} value={formatTokens(current().input)} />
            <Row theme={theme} label="out" color={palette.out} value={formatTokens(current().output)} />
            <Row
              theme={theme}
              label="cache"
              color={palette.cache}
              value={formatTokens(current().cache)}
              suffix={`${Math.round(current().cacheHit)}% hit`}
            />
            <Show when={config.showReasoning}>
              <Row
                theme={theme}
                label="think"
                color={palette.think}
                value={formatTokens(current().reasoning)}
                suffix={current().reasoningEstimated ? "~est" : undefined}
              />
            </Show>
            <Show when={config.scope === "session"}>
              <Row
                theme={theme}
                label="total"
                color={theme().text.muted}
                value={formatTokens(current().used)}
                suffix={config.showCost && cost() > 0 ? formatMoney(cost()) : undefined}
              />
            </Show>
          </box>
        )
      }}
    </Show>
  )
}

function makeDiag(enabled: boolean) {
  if (!enabled) return () => {}
  const target = new URL("../.diagnostic.log", import.meta.url)
  return (line: string) => {
    try {
      // TUI plugin errors surface as toasts in the terminal, never in the
      // opencode log, so mirror diagnostics into a file next to the plugin.
      appendFileSync(target, `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const options = context.options as Record<string, any> | undefined
    const config = readConfig(options)
    const diag = makeDiag(options?.debug === true)
    diag(`setup() ok config=${JSON.stringify(config)}`)
    let reported = ""
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        // render() runs on every reactive tick; only write when the numbers
        // actually move, so the log shows history instead of thousands of
        // identical lines.
        const messages = context.data.session.message.list(input.sessionID) ?? []
        const assistants = messages.filter(isAssistant)
        const anchor = assistants.findLast((m: any) => positive(m.tokens?.output) > 0) ?? assistants.at(-1)
        const line = JSON.stringify({
          messages: messages.length,
          steps: assistants.length,
          model: `${(anchor as any)?.model?.providerID ?? "-"}/${(anchor as any)?.model?.id ?? "-"}`,
          live: usageFor(anchor, config) ?? null,
          rows: sessionUsageFor(messages, config) ?? null,
        })
        if (line !== reported) {
          reported = line
          diag(line)
        }
        return <Panel context={context} sessionID={input.sessionID} config={config} />
      },
    })
  },
})
