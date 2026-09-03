---
name: pi-image-gen
description: Generate and edit raster images through configured image providers.
---

# Image Generation Plugin

Use the `pi.image-gen` plugin through `plugin_call`:

```ts
return await plugin["pi.image-gen"].image_generate({
  prompt: "A clean product illustration",
  n: 1,
});
```

Read `references/api.md` for the complete schema. Image inputs may be local file paths or `http(s)` URLs. Generated files are written below the session working directory or the configured output directory; existing files are not overwritten. Provider credentials are read from Desktop secret configuration or the corresponding environment variable and are never returned in results.

The method returns markdown image paths. Preserve those paths in the final response so the generated images can be rendered. Errors returned in tool context should guide the next corrected call.
