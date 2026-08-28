# Office Engine Performance Gate

`npm --prefix packages/office-engine run performance:check -- <report.json>` runs deterministic resource checks with `--expose-gc`.

The gate covers:

- byte-identical open and no-op serialization with deterministic 10 MiB and 50 MiB stored payloads;
- DOCX inspection with 1,000 and 10,000 direct paragraphs;
- planning, committing, and reopening one run edit in the 10,000-paragraph document;
- XLSX inspection plus planning, committing, and reopening one cell edit in a deterministic 10,000-cell worksheet.

`packages/office-engine/scripts/performance-budget.json` stores the measured baseline separately from failure thresholds. Baselines are evidence, not limits. Thresholds are intentionally above the recorded values to absorb hosted-runner variation while still catching order-of-magnitude regressions.

The `performance` job in `.github/workflows/office-interop.yml` runs on hosted Ubuntu and uploads `office-performance.json`. A threshold violation fails the job. The existing security tests separately verify that oversized, high-ratio, deeply nested, and otherwise hostile packages are rejected within configured budgets.

When changing a threshold:

1. run the fixed benchmark on the current CI runner class;
2. update `baseline` with the measured report and environment;
3. justify the new threshold in review;
4. never raise a threshold merely to make a regression pass.
