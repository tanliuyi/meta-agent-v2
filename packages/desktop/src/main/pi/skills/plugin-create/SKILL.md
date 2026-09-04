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
3. Use a manifest-backed directory whenever the plugin exposes composed operations through `run_code`; the manifest supplies stable identity, skill, and catalog metadata. Add `package.json` only when the plugin needs its own dependencies or distribution metadata.
4. Define every model-callable operation once with standard `pi.registerTool()`. Native tools stay direct; Desktop captures registrations only for entries opting into `run_code`. Do not add a parallel `desktopPlugin` handler.
5. Add an idempotent `session_shutdown` handler for every session-scoped resource used by a default Pi factory. Pass `AbortSignal` through to cancellable work.
6. Validate parameter schemas, normalize paths against `ctx.cwd`, bound external input and output, and throw errors from tool execution when an operation fails.
7. Run the narrowest available typecheck and focused tests. Test startup plus each registered tool, command, or event path without using paid provider calls.
8. Explain how to load the exact entry through Desktop Settings > Extensions > Developer Mode > Add local extension. Changes affect new sessions immediately; run `/reload` in an existing session to reload its approved extensions.

## Programmatic Tool Template

Use the standard Pi tool shape. Desktop intercepts this registration for manifest-backed plugins with `plugin-methods.provide`; the individual schema is not exposed to the model.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function plugin(pi: ExtensionAPI) {
  pi.registerTool({
    name: "lookup",
    label: "Lookup",
    description: "Look up one record by ID",
    parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const record = await lookupRecord(params.id, signal, onUpdate, ctx);
      return {
        content: [{ type: "text", text: JSON.stringify(record) }],
        details: { recordId: params.id },
      };
    },
  });
}
```

The manifest must declare `plugin-methods.provide`, `pi.skills`, and `pi.runCode` for `run_code` composition. The catalog documents the registered names and schemas; it is not a second executable implementation. The primary skill must document canonical bracket syntax such as `plugin["com.example.records"].lookup(...)`, link `references/api.md`, and explain limits, side effects, errors, and workflows.

## Host-Owned Native Tools

Ordinary third-party plugin tools are always captured. A direct model-facing tool is a Desktop-owned infrastructure exception and is not selected by plugin code or manifest metadata.

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

1. Confirm a tool plugin is a manifest-backed directory with a stable `plugin.id`, primary `SKILL.md`, generated `references/api.md`, and `plugin-api.json` covering every captured registration.
2. Typecheck against the installed Pi packages and fix all diagnostics.
3. Exercise every new tool, command, and event handler with deterministic fixtures or fakes.
4. Verify cleanup on `session_shutdown` for opened resources.
5. Verify Desktop-compatible UI paths and absence of unsupported TUI calls.
6. Report what was tested and identify any step that still requires manual Developer Mode approval or marketplace publication access.
