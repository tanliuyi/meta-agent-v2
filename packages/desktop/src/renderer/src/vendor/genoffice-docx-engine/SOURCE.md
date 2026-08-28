# GenOffice DOCX Engine Source Record

This directory contains a selectively vendored copy of the Apache-2.0 DOCX engine from GenOffice.

- Upstream repository: `https://github.com/genspark-ai/genoffice`
- Upstream commit: `583a045212f871943afb8ca4503fcb5ddf99a23f`
- Source path: `packages/docx-engine/src`
- License: Apache License 2.0, reproduced in `LICENSE`
- Upstream notice: GenOffice, Copyright 2026 Mainfunc, Inc.

The upstream `ee/` directory and product branding are not included.

## Local Changes

- The source is scoped under the Desktop renderer instead of an upstream workspace package.
- `parse.ts` imports `parseCustGeom` from the local `custgeom.ts` module.
- `custgeom.ts` was sourced from the same upstream commit at `packages/pptx-engine/src/custgeom.ts`; its public result type was reduced to the fields consumed by this DOCX engine.
- Desktop calls the focused `parse.ts`, `patch.ts`, `generate.ts`, and `types.ts` modules directly instead of the upstream package barrel.

## Nested Component

`vendor/emf-converter` is the upstream bundled EMF converter. Its Apache-2.0 license and attribution are retained in `vendor/emf-converter/LICENSE` and `vendor/emf-converter/README.md`.
