---
name: plugin-create
description: Creates and validates standard Pi Extension plugins for Meta Agent Desktop. Use when a user asks to build, scaffold, modify, debug, or prepare their own Desktop plugin.
compatibility: Meta Agent Desktop Host Profile v1 and the standard Pi Extension API.
---

# Create a Desktop Plugin

Treat a Desktop plugin as a standard Pi Extension. Do not invent a Desktop-only plugin runtime or import Electron main, preload, renderer, or private Desktop modules. For the manifest, configuration schema, Host Profile, loading, and packaging contract, read `desktop-plugin-development` and its focused `references/` documents before making design decisions.

## Workflow

1. Clarify the plugin's user-visible behavior, scope, external services, credentials, destructive actions, and whether it needs tools, commands, events, or a provider. Ask only for decisions that materially affect behavior or trust.
2. Inspect the target directory, its package manager, existing extension patterns, TypeScript configuration, and installed Pi API types before writing code. Reuse local conventions and do not guess external API signatures.
3. Choose the smallest viable structure:
   - Use one `index.ts` for a small plugin without extra runtime dependencies.
   - Use a directory with `index.ts` plus focused modules for shared state or multiple tools.
   - Add `package.json` only when the plugin needs its own dependencies or is intended for distribution.
4. Implement a default factory export that receives `ExtensionAPI`. Keep registration deterministic and move long-lived process, socket, watcher, and timer startup to `session_start` or the operation that needs it.
5. Add an idempotent `session_shutdown` handler for every session-scoped resource. Pass `AbortSignal` through to cancellable work.
6. Validate parameter schemas, normalize paths against `ctx.cwd`, bound external input and output, and throw errors from tool execution when an operation fails.
7. Run the narrowest available typecheck and focused tests. Test startup plus each registered tool, command, or event path without using paid provider calls.
8. Explain how to load the exact entry through Desktop Settings > Extensions > Developer Mode > Add local extension. Changes affect new sessions immediately; run `/reload` in an existing session to reload its approved extensions.

## Minimal Template

Use the currently installed package exports. `typebox` is available for tool schemas, and `StringEnum` from `@earendil-works/pi-ai` should be used for string enums that must work across providers.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function plugin(pi: ExtensionAPI) {
  pi.registerTool({
    name: "example_action",
    label: "Example Action",
    description: "Describe exactly when the model should call this tool",
    parameters: Type.Object({
      input: Type.String({ description: "Input to process" }),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation cancelled");
      return {
        content: [{ type: "text", text: params.input }],
        details: {},
      };
    },
  });
}
```

Do not retain placeholder tools or comments in the finished plugin.

## Desktop Host Profile

Prefer surfaces supported by Desktop Host Profile v1:

- Standard extension events, tools, commands, custom messages, session reads, and abort. Use compaction only when the installed Desktop characterization covers the exact flow; Host Profile v1 treats it as conditionally supported.
- `pi.getConfig()` returns the immutable, host-validated configuration scoped to the current extension. Marketplace configuration schemas are artifact metadata; Desktop renders their fields, stores non-secret values in an owner-only settings file, encrypts secret values with Electron `safeStorage`, and never returns secret plaintext to the renderer. Configuration fields may declare `widget: "model-selector"` with `modelFormat: "model-id" | "provider-model"` so Desktop renders a model picker instead of a text input; the marketplace validates these exactly like Developer Mode manifests (see `desktop-plugin-development/references/configuration-schema.md`).
- `ctx.ui.select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setTitle`, `setEditorText`, and `pasteToEditor`.
- `ctx.ui.setWidget` only with `string[]` content.
- `ctx.ui.setWorkingMessage` and `setWorkingVisible`; the working message is shown above the composer while the session is running.
- Provider registration only when the plugin genuinely supplies a provider; verify it against the installed Pi types and Desktop marketplace compatibility.

Do not use these unsupported Desktop surfaces:

- `ctx.ui.custom`, TUI component renderers, themes, headers, footers, custom editors, terminal input, or autocomplete providers.
- `pi.registerShortcut()` and `pi.registerFlag()` as Desktop user entry points; Desktop does not expose Pi TUI keybindings or Pi CLI flag parsing.
- `getEditorText` (returns undefined with a warning), working-indicator frames, hidden-thinking labels, or tools-expanded state.
- Session replacement methods such as `newSession`, `fork`, `navigateTree`, or `switchSession`.
- `ctx.reload` as part of the plugin workflow. Desktop applies extension-set changes by replacing the worker.

Custom TUI `renderCall`, `renderResult`, message renderers, and entry renderers do not produce Desktop React UI. Keep tool results useful through plain `content` and structured `details`.

## Correctness Rules

- Extensions run as full-trust Node code. Never describe them as sandboxed. Surface file, network, environment, subprocess, credential, native-code, and destructive-operation risks to the user.
- Use top-level imports and a default factory export. Keep secrets in environment or supported auth storage, never in source or logs.
- Use `promptSnippet` and `promptGuidelines` only when they improve tool selection. Every guideline must name its tool explicitly.
- Use `withFileMutationQueue()` around the complete read-modify-write window when a custom tool mutates a file that built-in tools may also edit.
- Truncate large tool output to Pi's normal 50 KB or 2,000-line boundary and tell the model where complete output was saved.
- Reconstruct branch-sensitive state from tool-result `details` or session entries instead of relying only on process memory.
- Avoid overriding built-in tools unless the user explicitly needs replacement behavior and the result shape remains compatible.
- For a distributable Pi package, declare Pi host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) as unbundled `peerDependencies` with `"*"`. Put other runtime packages in `dependencies` using exact versions unless the project has a stricter policy.
- Do not add install or post-install lifecycle scripts without an explicit requirement and review.

## Distribution Boundary

For local development, create an ordinary extension entry and use Desktop Developer Mode. Desktop does not auto-discover arbitrary global or project extensions.

Marketplace accounts, publisher authorization, artifact assembly, upload, signing, and release lifecycle belong to the built-in `plugin-publish` skill. When publication is requested, finish the plugin compatibility and focused validation work here, then load `plugin-publish`; do not fabricate an upload command or endpoint. Marketplace artifacts must be fully assembled ahead of installation, include every non-host runtime dependency, declare every payload file and capability, and must not depend on install scripts or on-device compilation.

## Verification

Before declaring completion:

1. Confirm the entry is a regular `.ts`, `.js`, `.mjs`, or `.cjs` file with a default extension factory export.
2. Typecheck against the installed Pi packages and fix all diagnostics.
3. Exercise every new tool, command, and event handler with deterministic fixtures or fakes.
4. Verify cleanup on `session_shutdown` for opened resources.
5. Verify Desktop-compatible UI paths and absence of unsupported TUI calls.
6. Report what was tested and identify any step that still requires manual Developer Mode approval or marketplace publication access.
