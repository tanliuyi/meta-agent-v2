---
name: plugin-publish
description: Adds or updates a Codex plugin entry in Marketplace JSON and verifies the resulting local installation workflow.
compatibility: Codex Marketplace JSON.
---

# Publish a Codex Plugin

Desktop discovers Codex Marketplace JSON. It does not publish signed Desktop artifacts or call the retired Meta Agent marketplace endpoint.

## Workflow

1. Validate the plugin with `plugin-create`.
2. Choose the Marketplace JSON. The personal Marketplace is `.agents/plugins/marketplace.json` under the user's home directory.
3. Add or update a plugin entry with a unique `name` and a local relative `source.path`.
4. Preserve existing Marketplace ordering unless the user requests a new order.
5. Keep optional Marketplace policy and interface fields intact.
6. Re-read the JSON and resolve the source path from the Marketplace root.
7. Install or update through Desktop and verify the managed copy, registry state, and new-session loading.

Use the standard Codex cachebuster version flow for local source updates. Do not edit the plugin's `plugin.json` during installation and do not create wrapper manifests or ZIP artifacts.

Remote URL sources are not installed by the current Desktop implementation. Report that limitation instead of inventing an endpoint or upload flow.
