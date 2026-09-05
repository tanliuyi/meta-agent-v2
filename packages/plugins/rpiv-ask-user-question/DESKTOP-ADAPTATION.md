# Desktop Compatibility

Upstream: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question

This snapshot supports terminal Pi, RPC hosts, and Meta Agent Desktop through capability detection.

## Execution paths

1. Hosts exposing `ctx.ui.questionnaire` receive the complete structured request in one call. Meta Agent Desktop implements this capability and renders the questionnaire in its Composer surface.
2. RPC or other hosts exposing `ctx.ui.select` and `ctx.ui.input` use the sequential native-dialog walker in `rpc-fallback.ts`.
3. Terminal Pi uses the tabbed `ctx.ui.custom` TUI implementation.

Structured and RPC host paths propagate cancellation through `AbortSignal`. All paths share parameter normalization, validation, lifecycle events, and response-envelope generation. The TUI render graph remains lazy so Desktop and RPC startup do not load the custom terminal questionnaire.

The plugin must not import Desktop main-process, preload, renderer, or private sidecar modules. Desktop integration is defined only by the structural `QuestionnaireUI` capability in `desktop-questionnaire.ts`.
