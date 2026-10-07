/**
 * Server entrypoint.
 *
 * This is a terminal-only plugin: it renders in the OpenCode client's session
 * sidebar and does nothing on the server. This file exists so the package is
 * also loadable from `opencode.json`, where the CLI resolves the terminal
 * entry from the same directory.
 *
 * The server side keeps its TypeScript source: only the client's Solid JSX
 * needs precompilation (see `scripts/build.mjs`), and the server plugin loader
 * executes TypeScript directly.
 */
export { default } from "./src/server.ts"
