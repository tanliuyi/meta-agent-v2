# Desktop Host Profile v1

Meta Agent Desktop runs standard Pi extensions in a controlled sidecar worker. Host Profile v1 describes the supported public surface; it does not make an extension sandboxed.

## Extension API

Use the installed `@earendil-works/pi-coding-agent` types. The factory receives `ExtensionAPI` and may use standard Pi registration and event APIs.

Supported registrations and their capability metadata:

| Pi surface | Capability |
| --- | --- |
| `pi.registerTool(...)` captured for `run_code` | `plugin-methods.provide` |
| `pi.on(...)` | `events.subscribe` |
| `pi.getConfig()` | `configuration.read` |
| Native `pi.registerTool(...)` exposed directly | `tools.register` |
| `pi.registerCommand(...)` | `commands.register` |
| `pi.registerProvider(...)` | `providers.register` |
| `pi.sendMessage(...)` | `messages.enqueue` |
| Custom message delivery | `messages.custom` |
| Session entry reads/reconstruction | `session.read` |
| Abort-aware session operations | `session.abort` |
| Compaction requests/hooks | `session.compact` |
| Supported Desktop UI calls | The matching `ui.*` capability |

Programmatic methods are captured from standard `pi.registerTool()` calls by the Desktop wrapper while the approved factory runs. Only entries declaring `plugin-methods.provide` use this path; entries declaring `tools.register` remain native Pi tools. Captured methods are exposed through the fixed `run_code` tool and do not run through nested Pi tool hooks. Desktop preserves `prepareArguments`, the TypeBox validator, execution mode, abort, updates, and the real `ExtensionContext`. The manifest catalog and primary skill document the captured API but do not define a second executable implementation.

## Supported UI

The following `ctx.ui` calls are intended for Desktop-compatible plugins:

- `select`, `confirm`, `input`, and `editor` for host dialogs.
- `notify` for short status or result notifications.
- `setStatus` for an extension status line.
- `setTitle` for the session/window title when genuinely useful.
- `setEditorText` and `pasteToEditor` for explicit composer workflows.
- `setWidget` with `string[]` content or a read-only Pi component factory; use the `ui.widget.text` capability for both.
- `ctx.ui.theme` and the widget factory's `theme` for semantic text colors.
- `setWorkingMessage` and `setWorkingVisible` for work that needs a visible progress state.

Keep UI calls optional. Extensions must continue to return useful plain text and structured `details` when no UI is available, such as RPC or child sessions.

## Widget Rendering

Desktop exposes `ctx.ui.widgetCapabilities = { components: true, input: false }` as an additional runtime capability. Check this property with `in` (it is not part of upstream Pi types) when selecting a component factory instead of an RPC-specific data payload. `ctx.mode` remains `"rpc"`; this does not enable terminal-only dialogs or editors.

The host calls `Component.render(width)` with the measured Desktop character width, forwards ANSI text to a read-only terminal surface, and refreshes at most every 250 ms. It calls `invalidate()` after width/theme changes and `dispose()` when replacing, clearing, resetting or disposing a widget. Use the injected `tui.terminal.columns` and `theme`, not process stdout dimensions or global Pi theme state. `tui.requestRender()` is coalesced into the refresh loop. Desktop's ANSI palette follows its theme.

Widgets are display-only: keyboard handlers, overlays, focus, direct terminal writes, and image protocols are not supported. Keep cleanup in `dispose()` for any timers or subscriptions owned by a factory. Host limits are 32 component widgets, 40 lines each, 300 columns, and 4096 source characters per line; oversized output is marked as truncated. Synchronous plugin render code is full-trust and cannot be preempted by these output limits.

Plain strings remain text, including JSON. Desktop does not infer plugin-specific schemas. Plugins that send an RPC protocol string must select their component factory using the capability above to obtain readable presentation.

## Unsupported TUI and Session Surfaces

Do not build a Desktop plugin around these Pi-only surfaces:

- `ctx.ui.custom`, theme switching/catalog APIs, headers, footers, custom editors, terminal input, or autocomplete providers. Read-only `setWidget` component factories and their injected theme are the exception.
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
4. Start a new session or apply the extension change so Desktop replaces the worker generation. Resource reload never mutates a live plugin method registry.
5. Test every registered tool, command, event, and shutdown path with deterministic fixtures.
6. Rebuild the sidecar before a real Electron smoke test so the test does not use stale copied resources.
