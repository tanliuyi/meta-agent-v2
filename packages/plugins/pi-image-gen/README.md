# Desktop Image Generation Plugin

A Meta Agent Desktop extension derived from
[`@amaster.ai/pi-image-gen`](https://github.com/TGYD-helige/pi/tree/master/packages/pi-image-gen)
under the Apache-2.0 license.

## Behavior

- Registers the `image_generate` tool.
- Defaults to the exact model ID `gpt-image-2`. There is no `image2` alias.
- Supports OpenAI, Gemini, DashScope, Volcengine Ark, and OpenRouter.
- Reads local or HTTP(S) reference images and writes generated images without overwriting existing files.
- Limits each input/output image to 25 MB and provider JSON responses to 50 MB.

## Configuration

The plugin ships a declarative Marketplace configuration schema
(`IMAGE_GEN_CONFIGURATION_SCHEMA` in `src/configuration.ts`). When installed from a
marketplace, Desktop renders its fields in **Plugin detail > 配置** and hands the
validated values to `pi.getConfig()`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultModel` | select | `gpt-image-2` | Built-in model quick pick (12 models, option descriptions show provider and aliases). Select **自定义模型…** to use a custom id. |
| `customModel` | text | – | Arbitrary model id (e.g. `openrouter/<vendor>/<model>`); used only when `defaultModel` is `custom`. Needs the matching provider key. |
| `outputDir` | path | `.pi/images` | Output directory, relative to the session cwd or absolute. |
| `<provider>ApiKey` | secret | – | API key for `openai`, `gemini`, `dashscope`, `ark`, `openrouter`. Stored encrypted by the Desktop credential store; never rendered back as plaintext. |
| `<provider>BaseUrl` | text | provider default | Base URL override; must start with `http://` or `https://`. |

Provider fields are grouped (`OpenAI`, `Google Gemini`, `Alibaba DashScope`,
`Volcengine Ark`, `OpenRouter`) in the settings form.

Credential resolution order:

1. Configuration value (`<provider>ApiKey`) from the Desktop settings form.
2. Environment variable fallback: `OPENAI_API_KEY`, `GEMINI_API_KEY`,
   `DASHSCOPE_API_KEY`, `ARK_API_KEY`, `OPENROUTER_API_KEY`.

Developer Mode entries do not receive Marketplace configuration forms; set the
environment variable for the provider you use before starting Desktop.

### Publishing

The schema is signed marketplace metadata, declared when creating the version
draft, and requires the `configuration.read` capability. Paste the JSON form of
`IMAGE_GEN_CONFIGURATION_SCHEMA` (or the pretty-printed
`IMAGE_GEN_CONFIGURATION_SCHEMA_JSON` export) into the publish dialog's
**配置 Schema** field. The marketplace validates it; Desktop re-validates it at
install and resolve time, so a draft accepted by the marketplace is guaranteed
renderable.

Regenerate the JSON after schema changes:

```sh
npx tsx -e "import { IMAGE_GEN_CONFIGURATION_SCHEMA_JSON } from './packages/plugins/pi-image-gen/src/configuration.ts'; console.log(IMAGE_GEN_CONFIGURATION_SCHEMA_JSON)"
```

## Load In Desktop

1. Open **Settings > Extensions** (redirects to **插件中心**).
2. Enable **Developer Mode** in the **本地插件** tab.
3. Choose **添加本地插件** and select this directory:
   `<repo>/packages/plugins/pi-image-gen`
   The directory ships a `market-manifest.json` declaring capabilities and the
   configuration schema, so the plugin detail dialog renders the same **配置**
   form (API keys, default model, output directory) that marketplace installs
   get. Selecting the bare `index.ts` file also works but skips the manifest and
   therefore the configuration form.
4. Apply the extension set. Desktop replaces the session worker; it does not hot-reload the entry in place.

Secrets saved in the local configuration form are encrypted with the same
system credential store as marketplace plugins. The environment variable
fallbacks still apply when a field is left empty.

Developer Mode extensions are full-trust Node code. This plugin can read local
reference images, access configured environment variables, make network requests
to image providers and supplied URLs, and write image files to the configured
output directory.

## Validation

```sh
npx tsc -p packages/plugins/pi-image-gen/tsconfig.json
node node_modules/vitest/dist/cli.js --run packages/plugins/pi-image-gen/test/plugin.test.ts
```
