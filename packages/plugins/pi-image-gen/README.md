# Desktop Image Generation Plugin

A Meta Agent Desktop Developer Mode extension derived from
[`@amaster.ai/pi-image-gen`](https://github.com/TGYD-helige/pi/tree/master/packages/pi-image-gen)
under the Apache-2.0 license.

## Behavior

- Registers the `image_generate` tool.
- Registers `/image-gen list` and `/image-gen generate <prompt>`.
- Defaults to the exact model ID `gpt-image-2`. There is no `image2` alias.
- Supports OpenAI, Gemini, DashScope, Volcengine Ark, and OpenRouter.
- Reads local or HTTP(S) reference images and writes generated images without overwriting existing files.
- Limits each input/output image to 25 MB and provider JSON responses to 50 MB.

## Credentials

Developer Mode entries do not receive Marketplace configuration forms. Set the key for the provider you use before starting Desktop:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `DASHSCOPE_API_KEY`
- `ARK_API_KEY`
- `OPENROUTER_API_KEY`

The extension also supports host configuration through `pi.getConfig()` for future packaged use. Supported scalar fields are `defaultModel`, `outputDir`, and `<provider>ApiKey` / `<provider>BaseUrl`, where `<provider>` is `openai`, `gemini`, `dashscope`, `ark`, or `openrouter`.

## Load In Desktop

1. Open **Settings > Extensions**.
2. Enable **Developer Mode**.
3. Choose **Add local extension** and approve this exact file:
   `<repo>/packages/plugins/pi-image-gen/index.ts`.
4. Apply the extension set. Desktop replaces the session worker; it does not hot-reload the entry in place.
5. Run `/image-gen list` to verify the selected model and credential state.

Developer Mode extensions are full-trust Node code. This plugin can read local reference images, access configured environment variables, make network requests to image providers and supplied URLs, and write image files to the configured output directory.

## Validation

```sh
npx tsc -p packages/plugins/pi-image-gen/tsconfig.json
node node_modules/vitest/dist/cli.js --run packages/plugins/pi-image-gen/test/plugin.test.ts
```
