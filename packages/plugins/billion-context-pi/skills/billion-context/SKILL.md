---
name: billion-context
description: Manage large conversations with ACP compression, search, status, and restoration workflows.
---

# Billion Context

Use this plugin when the conversation is large or context pressure requires compression. These are native Pi tools:

- `compress({ content: [...] })`
- `decompress({ blockId: "b5" })`
- `search_context({ query: "..." })`
- `acp_status({})`

Read [references/api.md](references/api.md) for complete parameter details. Intermediate state stays inside the method call; return only the result needed by the model. Compression changes conversation state, while decompression defaults to writing large content to a file.
