# pi-stef-figma

Figma REST API tools, compact design context, and Jira-linked Figma summaries.

Local fork of [`@pi-stef/figma`](https://github.com/sfiorini/pi-stef) (v0.3.5) adapted for **Meta Agent Desktop**:

- Entry is `extensions/figma.ts` with `market-manifest.json` for Developer Mode loading.
- `apiToken` is read from the Desktop extension settings (`pi.getConfig()`); Desktop stores it as an encrypted secret. Token lookup order: Desktop config → `~/.pi/sf/figma/config.json` → `FIGMA_API_TOKEN`/`FIGMA_TOKEN`/`FIGMA_ACCESS_TOKEN` → `.mcp.json` compatibility fallback.
- `@sinclair/typebox` replaced with the host `typebox` package; `@pi-stef/paths` inlined into `src/auth/FigmaAuthorization.ts`; other `@pi-stef/*` workspace dependencies removed (unused by the Figma tool surface).
- Jira/Confluence enrichment from `@pi-stef/atlassian` is not bundled here; the Figma tools work standalone.

Use this package when implementation work starts from Figma files, frames, FigJam boards, or Jira tickets that contain Figma design links. It keeps the existing `figma_context` workflow while adding broader `figma_*` REST tools for search, summaries, assets, comments, variables, styles, and raw debugging escape hatches.

## Desktop Setup And Auth

Load the plugin through Desktop Settings > Extensions > Developer Mode > Add local extension, selecting this directory (`packages/plugins/pi-stef-figma`). Then set the Figma API token in Settings > Extensions under the plugin's configuration.

For the upstream CLI workflow, create the canonical config file:

```bash
mkdir -p ~/.pi/sf/figma
cat > ~/.pi/sf/figma/config.json <<'JSON'
{
  "apiToken": "MY_TOKEN"
}
JSON
chmod 600 ~/.pi/sf/figma/config.json
```

For the upstream CLI workflow, install the original package:

```bash
pi install npm:@pi-stef/figma
```

Use `--dry-run` first when you want to inspect the Pi install command:

```bash
pi install npm:@pi-stef/figma --dry-run
```

Check token discovery without printing the token:

```text
figma_auth_status
figma_auth_status fileKey="abc123"
```

Without a `fileKey`, `figma_auth_status` only checks local config presence. With a `fileKey`, it makes the smallest safe Figma request needed to verify API access.

Compatibility fallbacks are supported during the first minor release after `figma` ships:

- `{ "apiKey": "..." }` in `~/.pi/sf/figma/config.json`
- `FIGMA_API_TOKEN`, `FIGMA_TOKEN`, or `FIGMA_ACCESS_TOKEN`
- compatible `.mcp.json` Figma token entries

New setups should use `{ "apiToken": "..." }` in `~/.pi/sf/figma/config.json`.

## Migration From figma-context

`figma` replaces the old `figma-context` package and keeps the compatibility tool name `figma_context`.

Before enabling this package, remove the old package from both Pi scopes if it was installed:

```bash
pi remove figma-context
pi remove -l figma-context
```

Do not enable both packages in the same Pi runtime. If another package registered `figma_context` first, this package skips duplicate registration and logs a migration warning.

## REST Tool Surface

Processed tools return compact, bounded output suitable for agent context:

| Tool | Purpose |
|---|---|
| `figma_parse_url` | Parse a Figma URL, bare file key, and optional node id. |
| `figma_auth_status` | Check local auth and optional file access without exposing tokens. |
| `figma_get_design_context` | Return page/frame context, hierarchy, and relevant nearby nodes. |
| `figma_get_node_summary` | Summarize layout, dimensions, styles, text, components, and children. |
| `figma_get_implementation_context` | Produce design-to-code layout, color, typography, spacing, asset, and accessibility hints. |
| `figma_extract_text` | Extract visible text nodes with paths and node ids. |
| `figma_find_nodes_by_name` | Search node names with compact path-aware results. |
| `figma_find_nodes_by_text` | Search visible text content. |
| `figma_render_nodes` | Return Figma image render URLs and optional downloaded artifacts. |
| `figma_extract_assets` | Build an asset manifest for renderable nodes and image fills. |
| `figma_get_styles` | List file styles. |
| `figma_get_variables` | List variables and collections when the token has library scopes. |
| `figma_get_components` | List file components. |
| `figma_get_component_sets` | List component sets. |
| `figma_search_components` | Search components by name. |
| `figma_get_comments` | Read file comments when the token has comment scope. |
| `figma_get_image_fills` | Retrieve expiring image-fill URLs. |

Raw escape hatches are explicit and capped:

| Tool | Purpose |
|---|---|
| `figma_get_file_raw` | Fetch raw file JSON for debugging. |
| `figma_get_nodes_raw` | Fetch raw node JSON for debugging. |

Prefer processed tools first. Use raw tools only when debugging a shape the compact transformers do not expose yet.

## Figma Context Workflow

`figma_context` keeps the original overview/screen concepts:

- `mode="overview"` is for pages, canvases, worksheets, and multi-screen flows.
- `mode="screen"` is for a focused frame or screen.

Recommended flow:

1. Start with `mode="overview"` for broad Jira or story links.
2. Pick relevant screen node IDs from the overview.
3. Re-run with `mode="screen"` for implementation details.

Useful options:

| Option | Notes |
|---|---|
| `format` | `markdown` for agent-readable text, or structured JSON when exact fields matter. |
| `includeRaw` | Adds raw tree data; use sparingly because output can grow quickly. |
| `includeHidden` | Includes hidden nodes. Defaults to visible-only summaries. |
| `includeStyles` | Includes style details where available. |
| `maxDepth` | Bounds tree traversal. |
| `maxScreens` | Bounds overview screen candidates. |
| `maxTextPerScreen` | Bounds extracted text per screen. |

## Atlassian Integration

In the upstream monorepo, `packages/atlassian` enriches Jira/Confluence context with Figma links (`story_context`, `jira_issue includeContext=true`). This local Desktop fork does not bundle the Atlassian package; the Figma tools run standalone. Install `@pi-stef/atlassian` separately if you need Jira-linked Figma summaries.

## Scopes And Permissions

Figma REST tokens need scopes that match the tool you call:

| Capability | Typical scope |
|---|---|
| Files, nodes, text, design context | `file_content:read` |
| Comments | `file_comments:read` |
| Components, styles, libraries | `library_assets:read` and `library_content:read` |

Some files also require membership or file-level access in Figma. A valid token without access to the target file returns 403/404-style guidance.

## Rate Limits And Caching

The REST client retries 429 responses using Figma's `Retry-After` header, up to a bounded retry cap. If rate limits continue, narrow requests with `ids`, `nodeId`, and `depth`, or wait before retrying.

Cacheable responses are stored under:

```text
$XDG_CACHE_HOME/pi/figma
```

or, when `XDG_CACHE_HOME` is unset:

```text
~/.cache/pi/figma
```

Clear cached responses with:

```bash
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/pi/figma"
```

Image render URLs and image-fill URLs are not cached because Figma treats them as expiring links.

## FigJam Slides And Limitations

URL parsing accepts Figma `/file`, `/design`, `/proto`, `/board`, and `/slides` links when a file key is present. REST detail varies by file type and token scope:

- FigJam and Slides documents may expose less design-to-code structure than design files.
- Prototype behavior, live selection, desktop MCP state, OAuth app publishing, webhooks, and mutating Figma APIs are out of scope.
- Large files should be queried by node id and bounded depth instead of raw full-file reads.

## Troubleshooting

| Symptom | Action |
|---|---|
| `Figma API token not found` | Create `~/.pi/sf/figma/config.json` with `{ "apiToken": "MY_TOKEN" }` or set a documented env fallback. |
| 401 or 403 | Check token validity, scopes, and file access. |
| 404 | Confirm the file key and node id, and verify the token can access the file. |
| 429 | Wait or narrow the request with node IDs and lower depth. |
| Request too large | Use `figma_get_nodes_raw`, `figma_get_design_context`, or `figma_context` with a node id and bounded depth. |
| Duplicate `figma_context` warning | Remove the legacy `figma-context` package from Pi global and project scopes. |

## Security Notes

- Tokens are read from local config or environment and are never printed by tools.
- `pi` does not scaffold secret-bearing Figma config files.
- Keep `~/.pi/sf/figma/config.json` at `chmod 600` when possible.
- Asset downloads only write when `outputDir` is explicit and resolved safely under the allowed working directory.
- Raw tools can return large file data; prefer compact tools for normal agent work.
