---
name: pi-officecli
description: Create, inspect, read, render, validate, and edit Office documents through OfficeCLI.
---

# OfficeCLI Plugin

Use the `pi.officecli` plugin through `plugin_call`. The plugin runs the pinned OfficeCLI binary and supports `.docx`, `.xlsx`, and `.pptx` files.

Read `references/api.md` for the exact method schemas. Use bracket syntax:

```ts
return await plugin["pi.officecli"].office_view({ file: "report.docx", mode: "outline", format: "text" });
```

All file paths are resolved against the session working directory. Mutating methods serialize through the OfficeCLI file mutation queue. `office_batch` is atomic by default. The plugin may download and execute the OfficeCLI binary when `binaryPath` is not configured; this requires network access and writes under the configured plugin data directory.

When a method returns an error, treat its code and message as tool context and correct the next call. Use `office_help` when an OfficeCLI property or path syntax is uncertain.
