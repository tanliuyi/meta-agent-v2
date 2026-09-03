---
name: billion-context
description: Manage large conversations with ACP compression, search, status, and restoration workflows.
---

# Billion Context

Use this plugin when the conversation is large or context pressure requires compression. Methods are available only inside `plugin_call`:

- `plugin["pi.billion-context"].compress({ content: [...] })`
- `plugin["pi.billion-context"].decompress({ blockId: "b5" })`
- `plugin["pi.billion-context"].search_context({ query: "..." })`
- `plugin["pi.billion-context"].acp_status({})`

Read [references/api.md](references/api.md) for complete parameter details. Intermediate state stays inside the method call; return only the result needed by the model. Compression changes conversation state, while decompression defaults to writing large content to a file.
