import { memo as _$memo } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { appendFileSync } from "node:fs";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { LayoutEvents } from "@opentui/core";
import { Plugin } from "@opencode/plugin/tui";
import { allocateSegments, EMPTY, FILLED, formatMoney, formatTokens } from "./bar.js";

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

const ID = "nano-context-opencode";

/** Rough characters-per-token, used only for the in-flight streaming estimate. */
const CHARS_PER_TOKEN = 4;

/** `"auto"` fills the sidebar; a number pins an exact cell count. */

const DEFAULTS = {
  label: "Context",
  barWidth: "auto",
  showReasoning: true,
  showCost: true,
  showTotal: true,
  estimateStreaming: true,
  estimateReasoning: false,
  scope: "turn"
};

/** Used until the measured width is known, and if the host never lays the box out. */
const FALLBACK_BAR_WIDTH = 37;
const MIN_BAR_WIDTH = 8;
const MAX_BAR_WIDTH = 200;
function readNumber(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
function readBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function readLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  return value === "" ? " " : value;
}
function readScope(value) {
  return value === "session" ? "session" : "turn";
}
function readBarWidth(value) {
  if (value === "auto") return "auto";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULTS.barWidth;
  return Math.round(Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, parsed)));
}

/** A measured box reports 0 until it has been laid out; keep the fallback then. */
function normalizeWidth(width) {
  if (!Number.isFinite(width) || width <= 0) return FALLBACK_BAR_WIDTH;
  return Math.round(Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, width)));
}
function readConfig(options) {
  const input = options ?? {};
  return {
    label: readLabel(input.label, DEFAULTS.label),
    barWidth: readBarWidth(input.barWidth),
    showReasoning: readBoolean(input.showReasoning, DEFAULTS.showReasoning),
    showCost: readBoolean(input.showCost, DEFAULTS.showCost),
    showTotal: readBoolean(input.showTotal, DEFAULTS.showTotal),
    estimateStreaming: readBoolean(input.estimateStreaming, DEFAULTS.estimateStreaming),
    estimateReasoning: readBoolean(input.estimateReasoning, DEFAULTS.estimateReasoning),
    scope: readScope(input.scope)
  };
}
function positive(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? value : 0;
}

/** Narrow an unknown message to an assistant message without importing client types. */
function isAssistant(message) {
  return typeof message === "object" && message !== null && message.type === "assistant";
}

/** Turn one assistant message's recorded tokens into the numbers the panel shows. */
function usageFor(message, config, streaming = 0) {
  if (!message) return undefined;
  const tokens = message.tokens ?? {};
  const cacheRead = positive(tokens.cache?.read);
  const cacheWrite = positive(tokens.cache?.write);
  const cache = cacheRead + cacheWrite;
  const input = positive(tokens.input);
  const recorded = positive(tokens.reasoning);

  // Some providers report reasoning inside `output` and leave `reasoning` at 0.
  // Estimate it from the reasoning blocks the turn actually stored, and flag it
  // so the row can say so rather than quietly inventing a number.
  let reasoning = recorded;
  let reasoningEstimated = false;
  if (reasoning === 0 && config.estimateReasoning) {
    let characters = 0;
    for (const part of message.content ?? []) {
      if (part?.type === "reasoning" && typeof part.text === "string") characters += part.text.length;
    }
    if (characters > 0) {
      reasoning = Math.round(characters / CHARS_PER_TOKEN);
      reasoningEstimated = true;
    }
  }

  // Folding reasoning into `out` when the segment is hidden keeps the bar honest.
  const output = positive(tokens.output) + (config.showReasoning ? 0 : reasoning) + streaming;

  // The prompt is the only thing a cache can ever apply to, so it is the
  // denominator for the hit rate.
  const prompt = input + cache;
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
    cacheHit: prompt > 0 ? cacheRead / prompt * 100 : 0
  };
}

/**
 * Sum every assistant step in the session.
 *
 * This is cumulative spend, not live context: twenty steps of a cached
 * conversation can total several times the model's context window, so this
 * number is only meaningful as "how much has this session consumed". It drives
 * the rows, never the window bar.
 */
function sessionUsageFor(messages, config) {
  let total;
  for (const message of messages) {
    if (!isAssistant(message) || !message.tokens) continue;
    const step = usageFor(message, config);
    if (!step) continue;
    if (!total) {
      total = {
        ...step
      };
      continue;
    }
    total.input += step.input;
    total.cache += step.cache;
    total.cacheRead += step.cacheRead;
    total.cacheWrite += step.cacheWrite;
    total.reasoning += step.reasoning;
    total.reasoningEstimated ||= step.reasoningEstimated;
    total.output += step.output;
    total.used += step.used;
    total.prompt += step.prompt;
  }
  if (total) total.cacheHit = total.prompt > 0 ? total.cacheRead / total.prompt * 100 : 0;
  return total;
}
function Row(props) {
  const theme = () => props.theme();
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("box"),
      _el$4 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "justifyContent", "space-between");
    _$setProp(_el$2, "wrapMode", "none");
    _$insert(_el$2, () => props.label);
    _$insertNode(_el$3, _el$4);
    _$setProp(_el$3, "flexDirection", "row");
    _$setProp(_el$3, "gap", 1);
    _$setProp(_el$3, "flexShrink", 0);
    _$setProp(_el$4, "wrapMode", "none");
    _$insert(_el$4, () => props.value);
    _$insert(_el$3, _$createComponent(Show, {
      get when() {
        return props.suffix;
      },
      get children() {
        var _el$5 = _$createElement("text");
        _$setProp(_el$5, "wrapMode", "none");
        _$insert(_el$5, () => props.suffix);
        _$effect(_$p => _$setProp(_el$5, "fg", theme().text.muted, _$p));
        return _el$5;
      }
    }), null);
    _$effect(_p$ => {
      var _v$ = props.color,
        _v$2 = theme().text.base;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}
function Panel(props) {
  const context = props.context;
  const config = props.config;
  const theme = () => context.theme;

  /**
   * The bar is drawn with block glyphs, so its length has to be decided in cells
   * — flexbox cannot stretch a run of text for us. Measure the slot's own box
   * instead of assuming the sidebar width, and follow layout changes so a
   * terminal resize does not leave a stale bar.
   */
  const [available, setAvailable] = createSignal(FALLBACK_BAR_WIDTH);
  let measured;
  const track = box => {
    measured = box;
    if (box) setAvailable(normalizeWidth(box.width));
  };
  onMount(() => {
    if (!measured) return;
    const onResize = () => setAvailable(normalizeWidth(measured.width));
    measured.on(LayoutEvents.RESIZED, onResize);
    onCleanup(() => measured?.off(LayoutEvents.RESIZED, onResize));
  });
  onCleanup(() => {
    measured = undefined;
  });
  const barWidth = createMemo(() => config.barWidth === "auto" ? available() : config.barWidth);
  const colors = createMemo(() => {
    const t = theme();
    return {
      in: t.hue.interactive[500],
      cache: t.hue.accent[500],
      think: t.text.feedback.warning.base,
      out: t.text.feedback.success.base,
      free: t.text.muted
    };
  });

  /**
   * The newest assistant message that has produced output is the one whose
   * numbers describe the current turn.
   */
  const anchor = createMemo(() => {
    const messages = context.data.session.message.list(props.sessionID) ?? [];
    const assistants = messages.filter(isAssistant);
    return assistants.findLast(m => positive(m.tokens?.output) > 0) ?? assistants.at(-1);
  });

  /**
   * While a reply streams the provider has not reported usage yet, so approximate
   * the visible output from the text accumulated so far. OpenCode replaces this
   * with exact figures when it records `time.completed`.
   */
  const streamingOutput = createMemo(() => {
    if (!config.estimateStreaming) return 0;
    const message = anchor();
    if (!message || message.time?.completed) return 0;
    let characters = 0;
    for (const part of message.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string") characters += part.text.length;
    }
    return characters === 0 ? 0 : Math.round(characters / CHARS_PER_TOKEN);
  });

  /**
   * What is resident in the model's context window right now. Always the last
   * step, whatever `scope` says, because the window only ever holds one step's
   * prompt.
   */
  const live = createMemo(() => usageFor(anchor(), config, streamingOutput()));

  /** What the rows report: this step, or every step in the session. */
  const usage = createMemo(() => {
    if (config.scope === "turn") return live();
    return sessionUsageFor(context.data.session.message.list(props.sessionID) ?? [], config);
  });
  const limit = createMemo(() => {
    const message = anchor();
    const ref = message?.model;
    if (!ref?.providerID || !ref?.id) return undefined;
    const location = context.location ?? context.data.location.default();
    const models = context.data.location.model.list(location) ?? [];
    // A message's ModelRef carries `id`; ModelInfo exposes both `id` and
    // `modelID`, and the built-in Context panel matches on `id`.
    const found = models.find(model => model.providerID === ref.providerID && model.id === ref.id);
    const size = found?.limit?.context;
    return typeof size === "number" && size > 0 ? size : undefined;
  });
  const percent = createMemo(() => {
    const current = live();
    const maximum = limit();
    if (!current || !maximum) return undefined;
    return Math.min(100, Math.round(current.used / maximum * 100));
  });
  const cost = createMemo(() => {
    const session = context.data.session.get(props.sessionID);
    const sessionCost = positive(session?.cost);
    if (sessionCost > 0) return sessionCost;
    return positive(context.data.session.cost(props.sessionID));
  });
  const segments = createMemo(() => {
    const current = live();
    if (!current) return [];
    const palette = colors();
    const maximum = limit();
    // Scale against the real window so `free` means something. When the turn
    // overflows the window, scale against the usage instead and fill the bar.
    const denominator = maximum !== undefined && current.used < maximum ? maximum : Math.max(current.used, 1);
    const buckets = [{
      key: "in",
      color: palette.in,
      value: current.input
    }, {
      key: "cache",
      color: palette.cache,
      value: current.cache
    }];
    if (config.showReasoning) buckets.push({
      key: "think",
      color: palette.think,
      value: current.reasoning
    });
    buckets.push({
      key: "out",
      color: palette.out,
      value: current.output
    });
    return allocateSegments(buckets, denominator, barWidth()).map(segment => segment.key === "free" ? {
      ...segment,
      color: palette.free
    } : segment);
  });
  return _$createComponent(Show, {
    get when() {
      return usage();
    },
    children: current => {
      const palette = colors();
      return (() => {
        var _el$6 = _$createElement("box"),
          _el$7 = _$createElement("text"),
          _el$8 = _$createElement("b"),
          _el$9 = _$createElement("text");
        _$insertNode(_el$6, _el$7);
        _$insertNode(_el$6, _el$9);
        _$use(track, _el$6);
        _$setProp(_el$6, "flexDirection", "column");
        _$setProp(_el$6, "width", "100%");
        _$insertNode(_el$7, _el$8);
        _$insert(_el$8, () => config.label);
        _$setProp(_el$9, "wrapMode", "none");
        _$insert(_el$9, _$createComponent(For, {
          get each() {
            return segments();
          },
          children: segment => (() => {
            var _el$11 = _$createElement("span");
            _$insert(_el$11, () => (segment.key === "free" ? EMPTY : FILLED).repeat(segment.cells));
            _$effect(_$p => _$setProp(_el$11, "style", {
              fg: segment.color
            }, _$p));
            return _el$11;
          })()
        }));
        _$insert(_el$6, _$createComponent(Show, {
          get when() {
            return config.showTotal || config.showCost && cost() > 0;
          },
          get fallback() {
            return _$createComponent(Show, {
              get when() {
                return _$memo(() => !!config.showCost)() && cost() > 0;
              },
              get children() {
                var _el$12 = _$createElement("text");
                _$setProp(_el$12, "wrapMode", "none");
                _$insert(_el$12, () => formatMoney(cost()));
                _$effect(_$p => _$setProp(_el$12, "fg", theme().text.muted, _$p));
                return _el$12;
              }
            });
          },
          get children() {
            var _el$0 = _$createElement("box"),
              _el$1 = _$createElement("text");
            _$insertNode(_el$0, _el$1);
            _$setProp(_el$0, "flexDirection", "row");
            _$setProp(_el$0, "justifyContent", "space-between");
            _$setProp(_el$1, "wrapMode", "none");
            _$insert(_el$1, () => config.scope === "session" ? "window  " : "", null);
            _$insert(_el$1, (() => {
              var _c$ = _$memo(() => !!config.showTotal);
              return () => _c$() ? _$memo(() => !!limit())() ? `${formatTokens(live()?.used ?? current().used)} / ${formatTokens(limit())} (${percent() ?? 0}%)` : formatTokens(live()?.used ?? current().used) : " ";
            })(), null);
            _$insert(_el$0, _$createComponent(Show, {
              get when() {
                return _$memo(() => !!(config.scope !== "session" && config.showCost))() && cost() > 0;
              },
              get children() {
                var _el$10 = _$createElement("text");
                _$setProp(_el$10, "wrapMode", "none");
                _$insert(_el$10, () => formatMoney(cost()));
                _$effect(_$p => _$setProp(_el$10, "fg", theme().text.muted, _$p));
                return _el$10;
              }
            }), null);
            _$effect(_$p => _$setProp(_el$1, "fg", theme().text.muted, _$p));
            return _el$0;
          }
        }), null);
        _$insert(_el$6, _$createComponent(Row, {
          theme: theme,
          label: "in",
          get color() {
            return palette.in;
          },
          get value() {
            return formatTokens(current().input);
          }
        }), null);
        _$insert(_el$6, _$createComponent(Row, {
          theme: theme,
          label: "out",
          get color() {
            return palette.out;
          },
          get value() {
            return formatTokens(current().output);
          }
        }), null);
        _$insert(_el$6, _$createComponent(Row, {
          theme: theme,
          label: "cache",
          get color() {
            return palette.cache;
          },
          get value() {
            return formatTokens(current().cache);
          },
          get suffix() {
            return `${Math.round(current().cacheHit)}% hit`;
          }
        }), null);
        _$insert(_el$6, _$createComponent(Show, {
          get when() {
            return config.showReasoning;
          },
          get children() {
            return _$createComponent(Row, {
              theme: theme,
              label: "think",
              get color() {
                return palette.think;
              },
              get value() {
                return formatTokens(current().reasoning);
              },
              get suffix() {
                return current().reasoningEstimated ? "~est" : undefined;
              }
            });
          }
        }), null);
        _$insert(_el$6, _$createComponent(Show, {
          get when() {
            return config.scope === "session";
          },
          get children() {
            return _$createComponent(Row, {
              theme: theme,
              label: "total",
              get color() {
                return theme().text.muted;
              },
              get value() {
                return formatTokens(current().used);
              },
              get suffix() {
                return _$memo(() => !!(config.showCost && cost() > 0))() ? formatMoney(cost()) : undefined;
              }
            });
          }
        }), null);
        _$effect(_$p => _$setProp(_el$7, "fg", theme().text.base, _$p));
        return _el$6;
      })();
    }
  });
}
function makeDiag(enabled) {
  if (!enabled) return () => {};
  const target = new URL("../.diagnostic.log", import.meta.url);
  return line => {
    try {
      // TUI plugin errors surface as toasts in the terminal, never in the
      // opencode log, so mirror diagnostics into a file next to the plugin.
      appendFileSync(target, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };
}
export default Plugin.define({
  id: ID,
  setup(context) {
    const options = context.options;
    const config = readConfig(options);
    const diag = makeDiag(options?.debug === true);
    diag(`setup() ok config=${JSON.stringify(config)}`);
    let reported = "";
    return context.ui.slot({
      append: "sidebar.content",
      render: input => {
        // render() runs on every reactive tick; only write when the numbers
        // actually move, so the log shows history instead of thousands of
        // identical lines.
        const messages = context.data.session.message.list(input.sessionID) ?? [];
        const assistants = messages.filter(isAssistant);
        const anchor = assistants.findLast(m => positive(m.tokens?.output) > 0) ?? assistants.at(-1);
        const line = JSON.stringify({
          messages: messages.length,
          steps: assistants.length,
          model: `${anchor?.model?.providerID ?? "-"}/${anchor?.model?.id ?? "-"}`,
          live: usageFor(anchor, config) ?? null,
          rows: sessionUsageFor(messages, config) ?? null
        });
        if (line !== reported) {
          reported = line;
          diag(line);
        }
        return _$createComponent(Panel, {
          context: context,
          get sessionID() {
            return input.sessionID;
          },
          config: config
        });
      }
    });
  }
});
