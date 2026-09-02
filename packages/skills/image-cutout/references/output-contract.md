# Output Contract

成功执行时，CLI 向标准输出写入一个 JSON 对象：

```json
{
  "status": "review",
  "route": "solid-background",
  "subject": "士兵、武器和背包",
  "guidance": {
    "rectangleCount": 2,
    "foregroundPointCount": 1,
    "backgroundPointCount": 2,
    "foregroundMask": false,
    "backgroundMask": false
  },
  "inputPath": "/absolute/input.png",
  "outputPath": "/absolute/output.png",
  "normalizedSize": { "width": 1024, "height": 1024 },
  "sourceRgbPreserved": false,
  "metrics": {
    "foregroundRatio": 0.42,
    "transitionRatio": 0.01,
    "foregroundComponents": 3,
    "foregroundTouchesBorder": false,
    "backgroundDistanceLow": 4.0,
    "backgroundDistanceHigh": 36.0,
    "opaqueSubjectRefinement": true,
    "foregroundThreshold": 144,
    "edgeInset": 1,
    "minComponentArea": 32,
    "rgbModifiedPixelCount": 5726
  },
  "warnings": ["background-assumption-requires-visual-review"],
  "artifacts": {
    "alpha": "/absolute/artifacts/alpha.png",
    "mask": "/absolute/artifacts/mask.png",
    "trimap": "/absolute/artifacts/trimap.png",
    "previewLight": "/absolute/artifacts/preview-light.png",
    "previewDark": "/absolute/artifacts/preview-dark.png",
    "previewChecker": "/absolute/artifacts/preview-checker.png"
  },
  "elapsedMs": 84
}
```

## Semantic Responsibility

`subject` records the invoking agent's visual decision about what the foreground means. It is required and must be non-empty whenever a new Alpha is generated. The CLI does not infer or verify that semantic decision. `guidance` records which spatial hints were supplied so a retry is reproducible. `--artifacts-dir` is also required for generated Alpha so the agent can complete the visual-review contract.

When an opaque input has no guidance, `--mode auto` fails with `error.code: "guidance-required"`. The invoking agent must inspect the image and explicitly select `background`, or supply guidance for `grabcut`.

## Status

- `pass`: deterministic checks found no structural risk. This normally applies only when preserving an existing valid Alpha channel.
- `review`: a new Alpha was generated and the invoking agent must compare the result with `subject` using the preview artifacts. Structural metrics are not evidence of semantic correctness.
- `error`: no result was generated. Exit code is `2`; details are in `error.code` and `error.message`.

A successful `review` exits with code `0`. Calling code must branch on `status`, not only on the process exit code.

Failure example:

```json
{
  "status": "error",
  "error": {
    "code": "guidance-required",
    "message": "The invoking agent must inspect the image and choose --mode background or provide GrabCut guidance"
  }
}
```

## Routes

- `existing-alpha`: preserves an existing non-opaque Alpha channel.
- `solid-background`: the invoking agent explicitly selected background removal and the deterministic estimator fitted a solid border background.
- `gradient-background`: the invoking agent explicitly selected background removal and the deterministic estimator fitted a planar gradient.
- `guided-grabcut`: GrabCut was initialized from agent-selected rectangles, points, or masks.

No route downloads or executes an additional model.

## Warnings and Metrics

Expected workflow warnings include:

- `guided-result-requires-visual-review`
- `background-assumption-requires-visual-review`
- `foreground-area-extreme`
- `foreground-touches-border`
- `many-foreground-components`
- `wide-transition-region`
- `background-model-uncertain`

`foregroundComponents` is diagnostic only. Multiple disconnected regions may all belong to the selected subject and are never removed solely because they are disconnected.

For background routes, `backgroundDistanceLow` is the estimated border-noise floor and `backgroundDistanceHigh` is the effective `--background-tolerance`. Raising the high value removes a wider range of colors connected to the border; it can also remove low-contrast foreground and therefore always requires visual review.

`opaqueSubjectRefinement` is present only when `--opaque-subject` was selected. It means the subject interior was made opaque and only the outer silhouette was feathered; it does not certify that the object is semantically opaque. `foregroundThreshold`, `edgeInset`, and `minComponentArea` record the optional agent-selected refinement parameters.

## Artifacts

When `--artifacts-dir` is supplied for existing Alpha, or as required for every newly generated Alpha, the CLI atomically writes:

- `alpha.png`: grayscale Alpha.
- `mask.png`: Alpha thresholded at 128.
- `trimap.png`: eroded structural preview of definite foreground, unknown edge, and definite background.
- `preview-light.png`: result composited over white.
- `preview-dark.png`: result composited over dark gray.
- `preview-checker.png`: result composited over a checkerboard.

These previews are required for the agent's visual review. They are diagnostics, not additional output variants.

## RGB Invariant

Input RGB is already composited with its original background. Preserving transition RGB exactly can create color fringes on a new background, so the background route follows these constraints:

- `alpha == 255`: RGB exactly matches the normalized input.
- `0 < alpha < 255`: RGB may be decontaminated using the estimated background, or propagated from the nearest opaque interior pixel under `--opaque-subject`.
- `alpha == 0`: RGB has no visible semantics and is excluded from the preservation claim.

`sourceRgbPreserved` is `true` only when no RGB pixel changed.
