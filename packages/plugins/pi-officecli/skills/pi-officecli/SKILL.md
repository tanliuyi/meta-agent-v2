---
name: pi-officecli
description: Create, inspect, edit, and render Office documents through OfficeCLI.
---

# OfficeCLI

Use `run_code` with `plugin["pi.officecli"].office_*` methods for document
workflows. Prefer read or inspect calls before edits, compose independent reads
with `Promise.all`, and return only the relevant OfficeCLI result. Read
`references/api.md` for the exact method parameters and result shape.
