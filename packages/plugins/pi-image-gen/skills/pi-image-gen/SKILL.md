---
name: pi-image-gen
description: Generate or edit bitmap assets through the image model.
---

# Image Generation

Use `run_code` with `plugin["pi.image-gen"].image_generate(...)` for image work.
Read `references/api.md` for the exact parameter schema and result shape.
Pass a concise prompt and return the generated file paths. Use `image` for local
reference files or URLs when editing, and use separate calls for distinct assets.
