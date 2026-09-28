/**
 * This is a terminal-only (TUI) plugin: everything it does happens in the
 * OpenCode client process, inside the session sidebar.
 *
 * The `./tui` entrypoint in package.json is what the CLI loads. This server
 * entry exists so the package is a well-formed plugin if it is ever listed in
 * `opencode.json` instead, where the CLI resolves `./tui` from the same package.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "nano-context-opencode.server",
  setup() {},
})
