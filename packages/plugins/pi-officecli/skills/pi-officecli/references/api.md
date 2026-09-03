# pi-officecli API

The generated `plugin-api.json` is the canonical schema source. Methods return `{ text: string }` and may create or modify files in the session working directory.

- `office_view`: Read a document semantic view.
- `office_get`: Read a document element by DOM path.
- `office_query`: Query document elements with a CSS-style selector.
- `office_dump`: Export a document or subtree as a replayable JSON blueprint.
- `office_create`: Create a new `.docx`, `.xlsx`, or `.pptx` document.
- `office_edit`: Add, set, remove, move, or swap document elements.
- `office_batch`: Apply multiple edits in one atomic batch.
- `office_merge`: Fill a template with JSON data into a new document.
- `office_validate`: Validate the OpenXML structure.
- `office_render`: Render a document to HTML or PNG.
- `office_help`: Query OfficeCLI command and element help.

For complete parameters, use the catalog rather than this summary.
