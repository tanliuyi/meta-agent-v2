---
name: desktop-plugin-development
description: Reference for Meta Agent Desktop plugin manifests, configuration schemas, Host Profile v1, loading, validation, and packaging. Use with plugin-create when implementing or reviewing a Desktop plugin.
compatibility: Meta Agent Desktop Host Profile v1 and the standard Pi Extension API.
---

# Desktop Plugin Development Reference

Use this skill as the Desktop-specific reference while implementing a standard Pi Extension. Use `plugin-create` for the implementation workflow and `plugin-publish` for marketplace operations.

## Product Boundary

A Desktop plugin is a standard Pi Extension running as trusted Node.js code inside the Desktop sidecar. It is not an Electron renderer plugin and it is not sandboxed.

- Import the public exports from the installed Pi packages. Do not import Desktop main-process, preload, renderer, or private sidecar modules.
- Export a default factory that receives `ExtensionAPI`.
- Keep file, network, subprocess, environment-variable, credential, native-code, and destructive-operation risks visible to the user.
- Declare capabilities from actual behavior. Capability declarations are compatibility and review metadata, not a sandbox.
- Keep long-lived resources behind `session_start` and clean them in an idempotent `session_shutdown` handler.

## Reference Map

Read the focused reference before editing that surface:

- [configuration-schema.md](references/configuration-schema.md): `market-manifest.json` configuration schema, validation, storage, and `pi.getConfig()`.
- [host-profile.md](references/host-profile.md): supported Host Profile v1 API, capability mapping, UI restrictions, and session boundaries.
- [loading-and-packaging.md](references/loading-and-packaging.md): Developer Mode loading, marketplace payloads, extension approval, child sessions, and verification.

## Minimal Development Plugin

A local plugin can be a single `index.ts` file:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function plugin(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "example_action",
    label: "Example Action",
    description: "Describe exactly when the model should call this tool.",
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

Use the installed package types rather than guessing method signatures. `typebox` is available for tool parameter schemas. Do not leave placeholder tools or placeholder comments in a finished plugin.

## Minimal Manifest

A directory selected through Developer Mode may include `market-manifest.json`. The manifest is required when the plugin needs Desktop configuration, capabilities, a stable plugin identity, or marketplace-compatible metadata.

```json
{
  "schemaVersion": 1,
  "marketplaceId": "meta-agent-development",
  "artifactId": "example-local",
  "plugin": {
    "id": "example.plugin",
    "name": "Example Plugin",
    "version": "1.0.0",
    "publisherId": "local"
  },
  "pi": {
    "entry": "index.ts",
    "extensionApi": "v1"
  },
  "desktop": {
    "hostProfileVersion": 1
  },
  "target": {
    "platform": "universal",
    "arch": "universal"
  },
  "capabilities": ["tools.register"],
  "nativeModules": [],
  "executables": [],
  "files": {
    "index.ts": { "mode": "0644" }
  }
}
```

For a local development directory, Desktop reads `plugin.name`, `plugin.id`, `pi.entry`, `desktop.hostProfileVersion`, `capabilities`, and the optional `configuration`. Marketplace artifacts additionally require the complete identity, target, native/executable declarations, and payload file metadata described in [loading-and-packaging.md](references/loading-and-packaging.md).

## Configuration Quick Start

Declare a schema in the manifest and include `configuration.read`:

```json
{
  "configuration": {
    "version": 1,
    "fields": [
      {
        "key": "endpoint",
        "label": "Endpoint",
        "type": "text",
        "placeholder": "https://api.example.test",
        "maxLength": 240,
        "group": "Connection",
        "order": 1
      },
      {
        "key": "timeoutSeconds",
        "label": "Timeout (seconds)",
        "type": "number",
        "defaultValue": 30,
        "minimum": 1,
        "maximum": 600,
        "step": 1,
        "group": "Connection",
        "order": 2
      }
    ]
  },
  "capabilities": ["configuration.read", "tools.register"]
}
```

Read [configuration-schema.md](references/configuration-schema.md) before adding fields. The extension receives the host-validated scalar values through `pi.getConfig()`:

```ts
interface PluginConfig {
  endpoint?: string;
  timeoutSeconds?: number;
}

export default function plugin(pi: ExtensionAPI): void {
  const config = pi.getConfig<PluginConfig>();
  // Treat config as immutable. Never log secrets or assume an optional field exists.
}
```

Desktop configuration is scoped to the approved extension entry. Values are immutable for the lifetime of that extension instance. Save configuration in Desktop Settings > Extensions; an existing worker may need `/reload` or a new session to receive a newly approved extension set.

## Verification Checklist

Before declaring a plugin ready:

1. The entry is a regular `.ts`, `.js`, `.mjs`, or `.cjs` file with a default factory export.
2. The manifest uses `desktop.hostProfileVersion: 1` and declares only supported capabilities.
3. Every schema field passes the v1 configuration parser and every required field has a valid value before runtime use.
4. Every tool, command, provider, and event path has deterministic focused coverage.
5. Open resources are cleaned up on `session_shutdown`; abort signals reach cancellable work.
6. The plugin does not depend on TUI rendering or Electron-private imports.
7. Local Developer Mode loading, `/reload`, and the relevant sidecar build path are understood and reported.
8. Marketplace payloads include every non-host runtime dependency and no credentials, tests, caches, or local-only files.
