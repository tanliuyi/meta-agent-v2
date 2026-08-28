# DOCX external interoperability gate

This gate proves that documents produced by the native DOCX transaction engine survive an external application open/save cycle without semantic loss, repair prompts, or material rendering changes.

## Matrix

The generated corpus contains these deterministic cases:

| Case | Operation | Source fixture |
| --- | --- | --- |
| `replace-text-run` | `replace_text_run` | `strict-format.docx` |
| `replace-text-range` | `replace_text_range` across runs | `open-as-read-only.docx` |
| `insert-paragraph` | `insert_paragraph_after` | `strict-format.docx` |
| `delete-paragraph` | `delete_paragraph` | `strict-format.docx` |
| `set-run-style` | bold and italic `set_text_run_style` | `strict-format.docx` |
| `replace-header-footer` | two `replace_related_text_run` operations | `header-footer.docx` |
| `replace-comment-text` | `replace_comment_text_run` | `comments.docx` |
| `no-op` | empty operation envelope and byte identity | `strict-format.docx` |

`interop:generate` first enforces the existing corpus admission checks for the fixture directory, SHA-256 values, licenses, and producer metadata. It then commits each operation through `planDocx` and `commitDocx`, reopens it with the engine, verifies its semantic probe, and writes a manifest containing the source fixture and generated SHA-256. The no-op case additionally requires exact package byte identity. The manifest schema fixes the complete ordered eight-case matrix and rejects missing, duplicate, reordered, path-like, or modified cases.

Each provider runner then:

1. validates the strict manifest and binds every generated input to its recorded SHA-256;
2. opens and saves every generated DOCX with the external application;
3. rejects missing executables, application failures, empty outputs, and repair/corruption/error diagnostics;
4. reopens every result with the native engine and verifies required text, forbidden text, and run style probes;
5. exports the generated input and external-save result to PDF, rasterizes every page at 144 DPI, and limits changed pixels to 1,000 with 1 percent color fuzz;
6. retains the manifest, DOCX files, PDFs, and page images as CI evidence.

## Local commands

Generate the deterministic inputs on any development machine:

```sh
npm --prefix packages/office-engine run interop:generate -- /tmp/office-interop
```

Run the LibreOffice lane with LibreOffice Writer, Poppler, and ImageMagick installed:

```sh
npm --prefix packages/office-engine run interop:libreoffice -- /tmp/office-interop
```

Set `LIBREOFFICE_BIN` when `soffice` is not on `PATH`. Set `OFFICE_INTEROP_MAX_DIFFERENT_PIXELS` only when an intentional rendering change has been reviewed and the threshold change is committed with its evidence.

Run the Microsoft Word lane from Windows PowerShell with desktop Word, Poppler, and ImageMagick installed:

```powershell
npm --prefix packages/office-engine run interop:word -- C:\Temp\office-interop
```

The Word runner uses COM automation with repair disabled and alerts suppressed. It additionally requires the COM application path to contain `WINWORD.EXE` published by `Microsoft Corporation`; ProgID-compatible alternative office suites fail closed. A COM open/save/export failure is a hard failure.

## CI and release gate

[`.github/workflows/office-interop.yml`](../../../.github/workflows/office-interop.yml) runs both the hosted LibreOffice lane and the `[self-hosted, Windows, office]` Word lane for Office engine pull requests, pushes to `main`, and manual dispatches.

A DOCX engine release is blocked until the commit has:

- a successful hosted LibreOffice check;
- a successful manual Word check on the configured Office runner;
- downloadable evidence artifacts from both jobs.

Engine self-reopen and producer fixtures are not substitutes for either external provider. If the Word runner is unavailable, the release remains blocked rather than skipped.
