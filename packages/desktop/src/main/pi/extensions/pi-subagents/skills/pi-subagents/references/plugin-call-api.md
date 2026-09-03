# pi-subagents plugin-call API

Use these methods inside `plugin_call` as `plugin["pi-subagents"].method(args)`.

## `subagent`

Runs the normal workflow executor. The exact parameter schema is configuration-sensitive; common fields include `workflowScript`, `agent`, `task`, `context`, `worktree`, `async`, `output`, `acceptance`, and `mission`. A workflow script must return a child result. Use explicit stable keys in `runs.run` and use `runs.all` for independent parallel lanes.

Do not use plugin_call to bypass child tool restrictions, model/provider policy, session ownership, approval gates, or the one-writer rule. Mutation workers require an explicit narrow task and should report changed files and verification results.

## `subagent_wait`

Waits for a provider item or an asynchronous child when the wait provider is enabled. It is non-blocking from the parent process perspective and must not be used to hide an unresolved child failure.

## Supervisor methods

`contact_supervisor`, `intercom`, and `subagent_supervisor` are available only when the corresponding parent channel is enabled. Their schemas use an action plus channel-specific fields such as `message`, `replyTo`, and `to`. Use the exact active schema; never invent a recipient or send secrets.

`structured_output` is an internal child-session tool and should not be called directly by the parent unless the active method schema explicitly exposes it.
