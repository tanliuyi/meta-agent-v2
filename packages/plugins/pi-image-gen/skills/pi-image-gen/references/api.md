# pi-image-gen API

`image_generate` returns `{ text: string }`. The text contains markdown links to saved image files.

Parameters:

- `prompt`: required generation or edit prompt.
- `image`: optional local paths or `http(s)` reference images.
- `n`: optional variant count, from 1 through 8.
- `size`: optional provider-specific size such as `1024x1024`.
- `quality`: optional `low`, `medium`, `high`, or `auto`.
- `filename`: optional output filename prefix.
- `outputDir`: optional output directory relative to the session cwd or an absolute path.

The configured model and provider determine the available backend. See `plugin-api.json` for the canonical schema.
