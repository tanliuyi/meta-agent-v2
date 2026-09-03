# pi-hermes-memory API

Use these methods inside `plugin_call` as `plugin["pi-hermes-memory"].method(args)`.

- `memory_search({ query, category?, project?, target?, limit? })`: find durable entries. Category values include `failure`, `correction`, `insight`, `preference`, `convention`, and `tool-quirk`; target is `memory`, `user`, or `failure`.
- `memory(args)`: manage stored memory. Follow the method schema for `action`, `category`, `content`, `old_text`, and `target` fields. Use `add`, `replace`, `remove`, or `search` only when supported by the active configuration.
- `session_search({ query, project?, role?, limit?, snippetChars? })`: legacy session search. `session_search({ markdown })`: anchor session search. The `plugin_call` method accepts either parameter shape; the active session-search variant determines which implementation runs.
- `skill_manage({ action, name, description?, scope?, ... })`: manage procedural skills. Creation requires a scope; project scope is for repository-specific procedures and global scope is portable. Use `view` without `skill_id` to list skills, or with `skill_id` to inspect one skill.

Results are text content intended for programmatic filtering. Keep returned snippets bounded with `limit` and `snippetChars` where available.
