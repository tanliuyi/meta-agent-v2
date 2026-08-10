# Desktop Host Profile v1

Meta Agent Desktop runs standard Pi extensions in a controlled sidecar worker. Host Profile v1 describes the supported public surface; it does not make an extension sandboxed.

## Extension API

Use the installed `@earendil-works/pi-coding-agent` types. The factory receives `ExtensionAPI` and may use standard Pi registration and event APIs.

Supported registrations and their capability metadata:

| Pi surface | Capability |
| --- | --- |
| `pi.on(...)` | `events.subscribe` |
| `pi.getConfig()` | `configuration.read` |
| `pi.registerTool(...)` | `tools.register` |
| `pi.registerCommand(...)` | `commands.register` |
| `pi.registerProvider(...)` | `providers.register` |
| `pi.sendMessage(...)` | `messages.enqueue` |
| Custom message delivery | `messages.custom` |
| Session entry reads/reconstruction | `session.read` |
| Abort-aware session operations | `session.abort` |
| Compaction requests/hooks | `session.compact` |
| Supported Desktop UI calls | The matching `ui.*` capability |

Capability names are declared in `market-manifest.json` and are checked for manifest compatibility. They are not a process sandbox; an extension still executes with the sidecar process's account permissions.

## Supported UI

The following `ctx.ui` calls are intended for Desktop-compatible plugins:

- `select`, `confirm`, `input`, and `editor` for host dialogs.
- `notify` for short status or result notifications.
- `setStatus` for an extension status line.
- `setTitle` for the session/window title when genuinely useful.
- `setEditorText` and `pasteToEditor` for explicit composer workflows.
- `setWidget` only with `string[]` content.
- `setWorkingMessage` and `setWorkingVisible` for work that needs a visible progress state.

Keep UI calls optional. Extensions must continue to return useful plain text and structured `details` when no UI is available, such as RPC or child sessions.

## Unsupported TUI and Session Surfaces

Do not build a Desktop plugin around these Pi-only surfaces:

- `ctx.ui.custom`, TUI component renderers, themes, headers, footers, custom editors, terminal input, or autocomplete providers.
- `pi.registerShortcut()` and `pi.registerFlag()` as Desktop user entry points. Desktop has no Pi TUI keybinding or Pi CLI flag workflow.
- `getEditorText`, working-indicator frames, hidden-thinking labels, or tools-expanded state.
- Session replacement methods such as `newSession`, `fork`, `navigateTree`, or `switchSession`.
- `ctx.reload` as a plugin workflow. Desktop applies extension-set changes by replacing the worker.
- Tool `renderCall`/`renderResult`, custom message renderers, or entry renderers as a way to create Desktop React UI. Their plain result data remains useful; their TUI component output does not become a renderer component.

Compaction is conditional. Use `session_compact` or compaction hooks only when the exact flow is covered by current Desktop characterization tests and the plugin declares `session.compact`.

## Lifecycle and State

- Register event handlers and tools synchronously in the factory.
- Start watchers, servers, sockets, timers, or child processes from `session_start` or on first use.
- Close every resource in an idempotent `session_shutdown` handler.
- Pass the provided `AbortSignal` into network and subprocess work.
- Reconstruct branch-sensitive state from session entries or tool-result `details`; do not rely on one worker process's memory after reload.
- Treat a captured `ctx` or `pi` as stale after any session replacement or reload event.
- Do not let a tool alter shared files without a complete read-modify-write mutation queue when Pi built-in tools can edit the same files.

## Trust and Data Handling

Plugins are full-trust code. A plugin may be able to access files, the network, environment variables, subprocesses, credentials, and native modules depending on its implementation. Explain these risks in the plugin's README and manifest description.

For secrets:

- Declare a `secret` configuration field instead of asking users to paste credentials into a normal text field.
- Read the secret only in the sidecar extension and keep it out of logs, tool results, crash messages, and generated files.
- Do not read the renderer's local storage or import Electron credential APIs from plugin code.
- Keep external service, browser cookie, subprocess, and destructive-operation behavior explicit.

## Child Sessions

`pi-subagents` is Desktop's orchestration layer. It owns worker lifecycle, cancellation, budgets, session attribution, permissions, and nested fanout. A plugin should not implement a competing raw Pi delegation system.

By default, child sessions do not inherit Desktop's built-in skills. A child that needs plugin-development guidance must receive an explicitly approved skill or a task-specific reference path through the orchestrator. Extension paths are also filtered to the parent session's approved set; a child must never inject an arbitrary extension path.

## Verification

For local development:

1. Enable Developer Mode in Desktop Settings > Extensions.
2. Add the plugin directory when it contains `market-manifest.json`, or add the entry file for a minimal plugin.
3. Confirm the manifest entry is a regular non-symlink file and the host profile is version 1.
4. Start a new session, or run `/reload` in an existing session when the extension set is reloadable.
5. Test every registered tool, command, event, and shutdown path with deterministic fixtures.
6. Rebuild the sidecar before a real Electron smoke test so the test does not use stale copied resources.
