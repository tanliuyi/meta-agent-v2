---
name: pi-browser
description: Use the shared Desktop browser through run_code for multi-step page workflows.
---

# Browser

Browser operations are available through `run_code` under `plugin["pi-browser"]`.
Use `browser_open` or `browser_tabs` first, then `browser_snapshot` before indexed
click or typing actions. Keep independent read-only calls in `Promise.all` and
return only the state needed for the next step. Read `references/api.md` for the
exact method parameters and result shape.
