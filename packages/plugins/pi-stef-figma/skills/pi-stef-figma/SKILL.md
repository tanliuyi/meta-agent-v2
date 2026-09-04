---
name: pi-stef-figma
description: Read Figma files and turn selected designs into implementation context.
---

# Figma

Use `run_code` with `plugin["pi-stef.figma"].figma_*` methods. Parse a Figma
URL first when needed, fetch focused context instead of the whole file, and
compose independent read calls with `Promise.all`. Read `references/api.md` for
the exact method parameters and result shape.
