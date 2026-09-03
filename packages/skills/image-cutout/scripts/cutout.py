#!/usr/bin/env python3
"""Model-agnostic image cutout CLI shipped with the image-cutout skill."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import warnings
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps


SUPPORTED_FORMATS = ("PNG", "JPEG", "WEBP")
PROCESSING_ROWS = 256


class CutoutError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CutoutError("invalid-arguments", message)


@dataclass(frozen=True)
class LoadedImage:
    rgb: np.ndarray
    alpha: np.ndarray
    had_alpha: bool
    width: int
    height: int


@dataclass(frozen=True)
class BackgroundEstimate:
    distance: np.ndarray
    route: str
    residual_p95: float
    solid_rgb: np.ndarray | None
    gradient_coefficients: np.ndarray | None


def parse_point(value: str) -> tuple[int, int]:
    try:
        parts = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("point must contain integers") from error
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("point must be x,y")
    return parts


def parse_rect(value: str) -> tuple[int, int, int, int]:
    try:
        parts = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("rectangle must contain integers") from error
    if len(parts) != 4 or parts[2] <= 0 or parts[3] <= 0:
        raise argparse.ArgumentTypeError("rectangle must be x,y,width,height with positive size")
    return parts


def parse_polygon(value: str) -> list[tuple[int, int]]:
    points = [parse_point(point) for point in value.split(";") if point.strip()]
    if len(points) < 3:
        raise argparse.ArgumentTypeError("polygon must contain at least three x,y points separated by semicolons")
    return points


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description="Extract a subject into an RGBA PNG")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", choices=("auto", "alpha", "background", "grabcut"), default="auto")
    parser.add_argument("--background-tolerance", type=float)
    parser.add_argument(
        "--opaque-subject",
        action="store_true",
        help="Make the background-route subject interior opaque and feather only its outer silhouette",
    )
    parser.add_argument("--foreground-threshold", type=int)
    parser.add_argument("--edge-inset", type=int)
    parser.add_argument("--min-component-area", type=int)
    parser.add_argument("--subject", help="Short description of the foreground selected by the invoking agent")
    parser.add_argument("--rect", type=parse_rect, action="append", default=[])
    parser.add_argument("--foreground-region", type=parse_rect, action="append", default=[])
    parser.add_argument("--background-region", type=parse_rect, action="append", default=[])
    parser.add_argument("--foreground-polygon", type=parse_polygon, action="append", default=[])
    parser.add_argument("--background-polygon", type=parse_polygon, action="append", default=[])
    parser.add_argument("--foreground-point", type=parse_point, action="append", default=[])
    parser.add_argument("--background-point", type=parse_point, action="append", default=[])
    parser.add_argument("--point-radius", type=int, default=3)
    parser.add_argument("--foreground-mask", type=Path)
    parser.add_argument("--background-mask", type=Path)
    parser.add_argument("--artifacts-dir", type=Path)
    parser.add_argument("--max-bytes", type=int, default=50 * 1024 * 1024)
    parser.add_argument("--max-pixels", type=int, default=8_000_000)
    parser.add_argument("--decontaminate-edges", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--json", action="store_true", help="Emit the stable JSON result contract")
    return parser


def load_image(path: Path, max_bytes: int, max_pixels: int) -> LoadedImage:
    if max_bytes <= 0 or max_pixels <= 0:
        raise CutoutError("invalid-limit", "Resource limits must be positive")
    if not path.is_file():
        raise CutoutError("invalid-input", f"Input file does not exist: {path}")
    if path.stat().st_size > max_bytes:
        raise CutoutError("resource-limit", f"Input exceeds --max-bytes ({max_bytes})")

    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(path, formats=list(SUPPORTED_FORMATS)) as opened:
                if opened.width * opened.height > max_pixels:
                    raise CutoutError("resource-limit", f"Input exceeds --max-pixels ({max_pixels})")
                had_alpha = "A" in opened.getbands() or "transparency" in opened.info
                normalized = ImageOps.exif_transpose(opened)
                normalized.load()
                rgba = np.asarray(normalized.convert("RGBA"), dtype=np.uint8).copy()
        except CutoutError:
            raise
        except (Image.DecompressionBombWarning, Image.DecompressionBombError) as error:
            raise CutoutError("resource-limit", str(error)) from error
        except Exception as error:
            raise CutoutError("invalid-input", f"Unable to decode image: {error}") from error

    height, width = rgba.shape[:2]
    if width * height > max_pixels:
        raise CutoutError("resource-limit", f"Normalized input exceeds --max-pixels ({max_pixels})")
    return LoadedImage(rgba[:, :, :3], rgba[:, :, 3], had_alpha, width, height)


def border_thickness(height: int, width: int) -> int:
    return min(64, max(1, round(min(height, width) * 0.03)))


def border_coordinates(height: int, width: int, thickness: int) -> tuple[np.ndarray, np.ndarray]:
    border = np.zeros((height, width), dtype=bool)
    border[:thickness, :] = True
    border[-thickness:, :] = True
    border[:, :thickness] = True
    border[:, -thickness:] = True
    return np.nonzero(border)


def estimate_background(rgb: np.ndarray) -> BackgroundEstimate:
    height, width = rgb.shape[:2]
    thickness = border_thickness(height, width)
    ys, xs = border_coordinates(height, width, thickness)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    median_lab = np.median(lab[ys, xs], axis=0).astype(np.float32)
    solid_distance = np.empty((height, width), dtype=np.float32)
    for start in range(0, height, PROCESSING_ROWS):
        end = min(height, start + PROCESSING_ROWS)
        difference = lab[start:end].astype(np.float32)
        difference -= median_lab
        solid_distance[start:end] = np.sqrt(np.sum(difference * difference, axis=2))
    solid_p95 = float(np.percentile(solid_distance[ys, xs], 95))
    if solid_p95 <= 18.0:
        solid_rgb = np.median(rgb[ys, xs], axis=0).astype(np.float32)
        return BackgroundEstimate(solid_distance, "solid-background", solid_p95, solid_rgb, None)
    del lab, solid_distance

    sample_count = len(xs)
    stride = max(1, sample_count // 20_000)
    sample_x = xs[::stride].astype(np.float32) / max(1, width - 1)
    sample_y = ys[::stride].astype(np.float32) / max(1, height - 1)
    design = np.column_stack((sample_x, sample_y, np.ones_like(sample_x)))
    colors = rgb[ys[::stride], xs[::stride]].astype(np.float32)
    coefficients, _, _, _ = np.linalg.lstsq(design, colors, rcond=None)
    coefficients = coefficients.astype(np.float32)
    normalized_x = np.linspace(0.0, 1.0, width, dtype=np.float32)
    distance = np.empty((height, width), dtype=np.float32)
    for start in range(0, height, PROCESSING_ROWS):
        end = min(height, start + PROCESSING_ROWS)
        normalized_y = np.arange(start, end, dtype=np.float32) / max(1, height - 1)
        background = (
            normalized_x[None, :, None] * coefficients[0]
            + normalized_y[:, None, None] * coefficients[1]
            + coefficients[2]
        )
        np.clip(background, 0, 255, out=background)
        difference = rgb[start:end].astype(np.float32)
        difference -= background
        distance[start:end] = np.sqrt(np.sum(difference * difference, axis=2))
    residual_p95 = float(np.percentile(distance[ys, xs], 95))
    return BackgroundEstimate(distance, "gradient-background", residual_p95, None, coefficients)


def background_rows(estimate: BackgroundEstimate, start: int, end: int, width: int) -> np.ndarray:
    if estimate.solid_rgb is not None:
        return np.broadcast_to(estimate.solid_rgb, (end - start, width, 3))
    coefficients = estimate.gradient_coefficients
    if coefficients is None:
        raise CutoutError("processing-failed", "Background estimate is incomplete")
    normalized_x = np.linspace(0.0, 1.0, width, dtype=np.float32)
    normalized_y = np.arange(start, end, dtype=np.float32) / max(1, estimate.distance.shape[0] - 1)
    background = (
        normalized_x[None, :, None] * coefficients[0]
        + normalized_y[:, None, None] * coefficients[1]
        + coefficients[2]
    )
    np.clip(background, 0, 255, out=background)
    return background


def connected_background(candidate: np.ndarray) -> np.ndarray:
    count, labels = cv2.connectedComponents(candidate.astype(np.uint8), connectivity=8)
    if count <= 1:
        return np.zeros_like(candidate, dtype=bool)
    border_labels = np.unique(np.concatenate((labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1])))
    border_labels = border_labels[border_labels != 0]
    return np.isin(labels, border_labels)


def alpha_from_background(
    estimate: BackgroundEstimate,
    tolerance: float | None,
) -> tuple[np.ndarray, float, float]:
    height, width = estimate.distance.shape
    thickness = border_thickness(height, width)
    ys, xs = border_coordinates(height, width, thickness)
    border_distance = estimate.distance[ys, xs]
    low = max(2.0, float(np.percentile(border_distance, 99.5)) + 1.0)
    minimum_high = 32.0 if estimate.route == "solid-background" else 16.0
    automatic_high = min(64.0, max(minimum_high, low + float(np.std(border_distance)) * 4.0))
    high = automatic_high if tolerance is None else tolerance
    if high <= low or high > 255.0:
        raise CutoutError(
            "invalid-background-tolerance",
            f"--background-tolerance must be greater than {low:.3f} and at most 255",
        )
    reachable = connected_background(estimate.distance <= high)
    normalized = np.clip((estimate.distance - low) / max(1.0, high - low), 0.0, 1.0)
    smooth = normalized * normalized * (3.0 - 2.0 * normalized)
    alpha = np.full((height, width), 255, dtype=np.uint8)
    alpha[reachable] = np.rint(smooth[reachable] * 255.0).astype(np.uint8)
    return alpha, low, high


def load_guidance_mask(
    path: Path,
    width: int,
    height: int,
    name: str,
    max_bytes: int,
) -> np.ndarray:
    if not path.is_file():
        raise CutoutError("invalid-guidance", f"{name} does not exist: {path}")
    if path.stat().st_size > max_bytes:
        raise CutoutError("resource-limit", f"{name} exceeds --max-bytes ({max_bytes})")
    try:
        with Image.open(path) as opened:
            if opened.size != (width, height):
                raise CutoutError("invalid-guidance", f"{name} must be {width}x{height}")
            opened.load()
            mask = np.asarray(opened.convert("L"), dtype=np.uint8)
    except CutoutError:
        raise
    except Exception as error:
        raise CutoutError("invalid-guidance", f"Unable to decode {name}: {error}") from error
    return mask >= 128


def alpha_from_grabcut(
    rgb: np.ndarray,
    rects: list[tuple[int, int, int, int]],
    foreground_points: list[tuple[int, int]],
    background_points: list[tuple[int, int]],
    foreground_regions: list[tuple[int, int, int, int]],
    background_regions: list[tuple[int, int, int, int]],
    foreground_polygons: list[list[tuple[int, int]]],
    background_polygons: list[list[tuple[int, int]]],
    point_radius: int,
    foreground_mask: Path | None,
    background_mask: Path | None,
    max_bytes: int,
) -> np.ndarray:
    height, width = rgb.shape[:2]
    if width < 3 or height < 3:
        raise CutoutError("invalid-input", "GrabCut requires an image of at least 3x3 pixels")
    if point_radius <= 0:
        raise CutoutError("invalid-guidance", "--point-radius must be positive")
    if not rects and not foreground_points and not foreground_regions and foreground_mask is None:
        raise CutoutError(
            "guidance-required",
            "GrabCut requires a rectangle, foreground point, or foreground mask selected by the invoking agent",
        )

    mask = np.full((height, width), cv2.GC_PR_BGD, dtype=np.uint8)
    for x, y, rect_width, rect_height in rects:
        if x < 0 or y < 0 or x + rect_width > width or y + rect_height > height:
            raise CutoutError("invalid-guidance", "Every rectangle must be fully inside the normalized image")
        mask[y : y + rect_height, x : x + rect_width] = cv2.GC_PR_FGD
    foreground = (
        load_guidance_mask(foreground_mask, width, height, "foreground mask", max_bytes).astype(np.uint8)
        if foreground_mask
        else np.zeros((height, width), dtype=np.uint8)
    )
    background = (
        load_guidance_mask(background_mask, width, height, "background mask", max_bytes).astype(np.uint8)
        if background_mask
        else np.zeros((height, width), dtype=np.uint8)
    )
    for name, regions, target in (
        ("foreground", foreground_regions, foreground),
        ("background", background_regions, background),
    ):
        for x, y, region_width, region_height in regions:
            if x < 0 or y < 0 or x + region_width > width or y + region_height > height:
                raise CutoutError("invalid-guidance", f"Every {name} region must be fully inside the normalized image")
            target[y : y + region_height, x : x + region_width] = 1
    for name, polygons, target in (
        ("foreground", foreground_polygons, foreground),
        ("background", background_polygons, background),
    ):
        for polygon in polygons:
            points = np.asarray(polygon, dtype=np.int32)
            if np.any(points[:, 0] < 0) or np.any(points[:, 1] < 0) or np.any(points[:, 0] >= width) or np.any(points[:, 1] >= height):
                raise CutoutError("invalid-guidance", f"Every {name} polygon must be fully inside the normalized image")
            cv2.fillPoly(target, [points], 1)
    for name, points, target in (
        ("foreground", foreground_points, foreground),
        ("background", background_points, background),
    ):
        for x, y in points:
            if x < 0 or y < 0 or x >= width or y >= height:
                raise CutoutError("invalid-guidance", f"{name.title()} point must be inside the normalized image")
            cv2.circle(target, (x, y), point_radius, 1, thickness=-1)
    foreground_selected = foreground.astype(bool)
    background_selected = background.astype(bool)
    if np.any(foreground_selected & background_selected):
        raise CutoutError("invalid-guidance", "Foreground and background guidance conflicts")
    mask[foreground_selected] = cv2.GC_FGD
    mask[background_selected] = cv2.GC_BGD
    if not np.any(np.isin(mask, (cv2.GC_BGD, cv2.GC_PR_BGD))):
        raise CutoutError("invalid-guidance", "GrabCut requires at least one background sample")
    if not np.any(np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD))):
        raise CutoutError("invalid-guidance", "GrabCut requires at least one foreground sample")

    background_model = np.zeros((1, 65), dtype=np.float64)
    foreground_model = np.zeros((1, 65), dtype=np.float64)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    cv2.grabCut(bgr, mask, None, background_model, foreground_model, 5, cv2.GC_INIT_WITH_MASK)

    binary = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)
    if not np.any(binary):
        raise CutoutError("segmentation-failed", "GrabCut did not find a foreground region")
    foreground_distance = cv2.distanceTransform(binary, cv2.DIST_L2, 3)
    background_distance = cv2.distanceTransform(1 - binary, cv2.DIST_L2, 3)
    foreground_distance -= background_distance
    del background_distance
    foreground_distance += 1.5
    foreground_distance /= 3.0
    np.clip(foreground_distance, 0.0, 1.0, out=foreground_distance)
    foreground_distance *= 255.0
    np.rint(foreground_distance, out=foreground_distance)
    result = foreground_distance.astype(np.uint8)
    result[foreground_selected] = 255
    result[background_selected] = 0
    return result


def refine_opaque_subject(
    rgb: np.ndarray,
    alpha: np.ndarray,
    foreground_threshold: int = 128,
    edge_inset: int = 0,
    alpha_cutoff: int = 64,
    min_component_area: int = 0,
) -> tuple[np.ndarray, np.ndarray, int]:
    foreground = (alpha >= foreground_threshold).astype(np.uint8)
    if min_component_area > 0:
        component_count, component_labels, component_stats, _ = cv2.connectedComponentsWithStats(
            foreground,
            connectivity=8,
        )
        keep_labels = np.arange(1, component_count, dtype=component_labels.dtype)[
            component_stats[1:, cv2.CC_STAT_AREA] >= min_component_area
        ]
        foreground = np.isin(component_labels, keep_labels).astype(np.uint8)
        del component_labels, component_stats
    background_count, background_labels, background_stats, _ = cv2.connectedComponentsWithStats(
        1 - foreground,
        connectivity=8,
    )
    border_labels = np.unique(
        np.concatenate(
            (
                background_labels[0, :],
                background_labels[-1, :],
                background_labels[:, 0],
                background_labels[:, -1],
            )
        )
    )
    maximum_pinhole_area = max(4, round(alpha.size * 0.0001))
    candidate_labels = np.arange(1, background_count, dtype=background_labels.dtype)
    pinhole_labels = candidate_labels[
        (background_stats[1:, cv2.CC_STAT_AREA] <= maximum_pinhole_area)
        & ~np.isin(candidate_labels, border_labels)
    ]
    if pinhole_labels.size:
        foreground[np.isin(background_labels, pinhole_labels)] = 1
    del background_labels, background_stats

    if edge_inset:
        original_foreground = foreground
        original_count, original_labels = cv2.connectedComponents(original_foreground, connectivity=8)
        cross_kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
        foreground = cv2.erode(original_foreground, cross_kernel, iterations=edge_inset)
        retained_components = np.unique(original_labels[foreground.astype(bool)])
        missing_components = np.setdiff1d(
            np.arange(1, original_count, dtype=original_labels.dtype),
            retained_components,
            assume_unique=True,
        )
        if missing_components.size:
            foreground[np.isin(original_labels, missing_components)] = 1
        del original_labels

    component_count, component_labels = cv2.connectedComponents(foreground, connectivity=8)
    if component_count <= 1:
        raise CutoutError("empty-foreground", "Opaque-subject refinement found no foreground")

    kernel = np.ones((3, 3), dtype=np.uint8)
    interior = cv2.erode(foreground, kernel, iterations=1).astype(bool)
    components_with_interior = np.unique(component_labels[interior])
    missing_components = np.setdiff1d(
        np.arange(1, component_count, dtype=component_labels.dtype),
        components_with_interior,
        assume_unique=True,
    )
    if missing_components.size:
        interior |= np.isin(component_labels, missing_components)
    confidence_threshold = max(224, foreground_threshold)
    color_seeds = interior & (alpha >= confidence_threshold)
    seeded_components = np.unique(component_labels[color_seeds])
    missing_seed_components = np.setdiff1d(
        np.arange(1, component_count, dtype=component_labels.dtype),
        seeded_components,
        assume_unique=True,
    )
    if missing_seed_components.size:
        color_seeds |= interior & np.isin(component_labels, missing_seed_components)
    del component_labels

    distance_to_interior, nearest_labels = cv2.distanceTransformWithLabels(
        (~color_seeds).astype(np.uint8),
        cv2.DIST_L2,
        5,
        labelType=cv2.DIST_LABEL_PIXEL,
    )
    del distance_to_interior
    color_lookup = np.zeros((int(nearest_labels.max()) + 1, 3), dtype=np.uint8)
    color_lookup[nearest_labels[color_seeds]] = rgb[color_seeds]

    refined_alpha = cv2.GaussianBlur(foreground * 255, (0, 0), sigmaX=0.8, sigmaY=0.8)
    refined_alpha[refined_alpha < alpha_cutoff] = 0
    refined_alpha[refined_alpha > 255 - alpha_cutoff] = 255
    refined_alpha[interior] = 255
    transition = (refined_alpha > 0) & (refined_alpha < 255)
    low_confidence_foreground = foreground.astype(bool) & (alpha < confidence_threshold)
    replace_color = transition | low_confidence_foreground
    refined_rgb = rgb.copy()
    refined_rgb[replace_color] = color_lookup[nearest_labels[replace_color]]
    modified = int(np.count_nonzero(np.any(refined_rgb != rgb, axis=2)))
    return refined_rgb, refined_alpha, modified


def decontaminate(
    rgb: np.ndarray,
    alpha: np.ndarray,
    estimate: BackgroundEstimate | None,
) -> tuple[np.ndarray, int]:
    if estimate is None:
        return rgb.copy(), 0
    output = rgb.copy()
    modified = 0
    height, width = alpha.shape
    for start in range(0, height, PROCESSING_ROWS):
        end = min(height, start + PROCESSING_ROWS)
        alpha_rows = alpha[start:end]
        transition = (alpha_rows > 0) & (alpha_rows < 255)
        if not np.any(transition):
            continue
        source_rows = rgb[start:end].astype(np.float32)
        background = background_rows(estimate, start, end, width)
        normalized_alpha = alpha_rows.astype(np.float32) / 255.0
        safe_alpha = np.maximum(normalized_alpha[transition, None], 0.08)
        corrected = (source_rows[transition] - (1.0 - safe_alpha) * background[transition]) / safe_alpha
        output_rows = output[start:end]
        output_rows[transition] = np.rint(np.clip(corrected, 0, 255)).astype(np.uint8)
        modified += int(np.count_nonzero(np.any(output_rows != rgb[start:end], axis=2)))
    return output, modified


def quality_metrics(
    alpha: np.ndarray,
    modified_pixels: int,
    background_residual_p95: float | None,
) -> tuple[dict[str, object], list[str], str]:
    foreground = alpha >= 128
    ratio = float(np.mean(foreground))
    transition_ratio = float(np.mean((alpha > 0) & (alpha < 255)))
    _, _, stats, _ = cv2.connectedComponentsWithStats(foreground.astype(np.uint8), connectivity=8)
    meaningful_components = int(np.count_nonzero(stats[1:, cv2.CC_STAT_AREA] >= max(4, alpha.size * 0.0001)))
    touches_border = bool(
        np.any(foreground[0, :])
        or np.any(foreground[-1, :])
        or np.any(foreground[:, 0])
        or np.any(foreground[:, -1])
    )
    warning_codes: list[str] = []
    if ratio < 0.005 or ratio > 0.95:
        warning_codes.append("foreground-area-extreme")
    if touches_border:
        warning_codes.append("foreground-touches-border")
    if meaningful_components > 4:
        warning_codes.append("many-foreground-components")
    if transition_ratio > 0.15:
        warning_codes.append("wide-transition-region")
    if background_residual_p95 is not None and background_residual_p95 > 28.0:
        warning_codes.append("background-model-uncertain")
    metrics: dict[str, object] = {
        "foregroundRatio": round(ratio, 6),
        "transitionRatio": round(transition_ratio, 6),
        "foregroundComponents": meaningful_components,
        "foregroundTouchesBorder": touches_border,
        "rgbModifiedPixelCount": modified_pixels,
    }
    if background_residual_p95 is not None:
        metrics["backgroundResidualP95"] = round(background_residual_p95, 3)
    return metrics, warning_codes, "review" if warning_codes else "pass"


def paths_refer_to_same_file(left: Path, right: Path) -> bool:
    if left == right:
        return True
    try:
        return left.exists() and right.exists() and os.path.samefile(left, right)
    except OSError:
        return False


def ensure_distinct_paths(destinations: list[Path], protected: list[Path]) -> None:
    for index, destination in enumerate(destinations):
        for other in [*protected, *destinations[:index]]:
            if paths_refer_to_same_file(destination, other):
                raise CutoutError(
                    "invalid-output",
                    f"Destination aliases a protected path: {destination}",
                )


def save_png_atomic(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        image.save(temporary_path, format="PNG")
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def artifact_paths(directory: Path) -> dict[str, Path]:
    return {
        "alpha": directory / "alpha.png",
        "mask": directory / "mask.png",
        "trimap": directory / "trimap.png",
        "previewLight": directory / "preview-light.png",
        "previewDark": directory / "preview-dark.png",
        "previewChecker": directory / "preview-checker.png",
    }


def save_composite_preview(
    foreground: Image.Image,
    alpha: Image.Image,
    background: Image.Image,
    path: Path,
) -> None:
    with Image.composite(foreground, background, alpha) as preview:
        save_png_atomic(preview, path)


def save_artifacts(directory: Path, rgba: np.ndarray) -> dict[str, str]:
    directory.mkdir(parents=True, exist_ok=True)
    alpha = rgba[:, :, 3]
    foreground = alpha >= 128
    kernel = np.ones((3, 3), dtype=np.uint8)
    sure_foreground = cv2.erode(foreground.astype(np.uint8), kernel, iterations=2).astype(bool)
    sure_background = cv2.erode((~foreground).astype(np.uint8), kernel, iterations=2).astype(bool)
    trimap = np.full(alpha.shape, 128, dtype=np.uint8)
    trimap[sure_background] = 0
    trimap[sure_foreground] = 255
    height, width = alpha.shape
    tile = max(8, min(32, round(min(height, width) / 20)))
    x_tiles = (np.arange(width) // tile) % 2
    checker_values = np.empty((height, width), dtype=np.uint8)
    for y in range(0, height, tile):
        checker_values[y : y + tile] = np.where(x_tiles == (y // tile) % 2, 224, 160)
    paths = artifact_paths(directory)
    save_png_atomic(Image.fromarray(alpha), paths["alpha"])
    save_png_atomic(Image.fromarray(np.where(foreground, 255, 0).astype(np.uint8)), paths["mask"])
    save_png_atomic(Image.fromarray(trimap), paths["trimap"])
    with Image.fromarray(rgba, "RGBA") as rgba_image:
        with rgba_image.convert("RGB") as foreground_image:
            with rgba_image.getchannel("A") as alpha_image:
                with Image.new("RGB", (width, height), (255, 255, 255)) as light:
                    save_composite_preview(foreground_image, alpha_image, light, paths["previewLight"])
                with Image.new("RGB", (width, height), (24, 24, 24)) as dark:
                    save_composite_preview(foreground_image, alpha_image, dark, paths["previewDark"])
                with Image.fromarray(checker_values, "L").convert("RGB") as checker:
                    save_composite_preview(foreground_image, alpha_image, checker, paths["previewChecker"])
    return {name: str(path.resolve()) for name, path in paths.items()}


def run(args: argparse.Namespace) -> dict[str, object]:
    started = time.perf_counter()
    input_path = args.input.resolve()
    output_path = args.output.resolve()
    if input_path == output_path:
        raise CutoutError("invalid-input", "Input and output paths must be different")
    loaded = load_image(input_path, args.max_bytes, args.max_pixels)
    guidance_paths = [path.resolve() for path in (args.foreground_mask, args.background_mask) if path is not None]
    has_spatial_guidance = bool(
        args.rect
        or args.foreground_region
        or args.background_region
        or args.foreground_polygon
        or args.background_polygon
        or args.foreground_point
        or args.background_point
        or guidance_paths
    )
    artifacts_directory = args.artifacts_dir.resolve() if args.artifacts_dir else None
    artifact_destinations = list(artifact_paths(artifacts_directory).values()) if artifacts_directory else []
    ensure_distinct_paths([output_path, *artifact_destinations], [input_path, *guidance_paths])

    has_useful_alpha = loaded.had_alpha and bool(np.any(loaded.alpha < 255))
    generates_alpha = args.mode in ("background", "grabcut") or (args.mode == "auto" and has_spatial_guidance)
    if generates_alpha and (not args.subject or not args.subject.strip()):
        raise CutoutError("subject-required", "A non-empty --subject is required when generating a new alpha")
    if generates_alpha and artifacts_directory is None:
        raise CutoutError("artifacts-required", "--artifacts-dir is required when generating a new alpha")
    subject = args.subject.strip() if args.subject else None
    if args.background_tolerance is not None and args.mode != "background":
        raise CutoutError("invalid-arguments", "--background-tolerance can only be used with --mode background")
    if args.opaque_subject and args.mode not in ("background", "grabcut", "auto"):
        raise CutoutError(
            "invalid-arguments",
            "--opaque-subject can only be used when generating Alpha with background or GrabCut guidance",
        )
    if args.min_component_area is not None and not args.opaque_subject:
        raise CutoutError("invalid-arguments", "--min-component-area requires --opaque-subject")
    if (args.foreground_threshold is not None or args.edge_inset is not None) and not args.opaque_subject:
        raise CutoutError(
            "invalid-arguments",
            "--foreground-threshold and --edge-inset require --opaque-subject",
        )
    foreground_threshold = 128 if args.foreground_threshold is None else args.foreground_threshold
    edge_inset = 0 if args.edge_inset is None else args.edge_inset
    min_component_area = 0 if args.min_component_area is None else args.min_component_area
    if not 1 <= foreground_threshold <= 254:
        raise CutoutError("invalid-foreground-threshold", "--foreground-threshold must be between 1 and 254")
    if not 0 <= edge_inset <= 4:
        raise CutoutError("invalid-edge-inset", "--edge-inset must be between 0 and 4")
    if min_component_area < 0 or min_component_area > loaded.width * loaded.height:
        raise CutoutError("invalid-component-area", "--min-component-area must be between 0 and the image area")
    if args.mode in ("alpha", "background") and has_spatial_guidance:
        raise CutoutError("invalid-arguments", f"Guidance inputs cannot be used with --mode {args.mode}")
    estimate: BackgroundEstimate | None = None
    background_distance_low: float | None = None
    background_distance_high: float | None = None

    if args.mode == "alpha":
        if not has_useful_alpha:
            raise CutoutError("missing-alpha", "Input does not contain non-opaque alpha")
        route = "existing-alpha"
        alpha = loaded.alpha
    elif args.mode == "grabcut" or (args.mode == "auto" and has_spatial_guidance):
        route = "guided-grabcut"
        alpha = alpha_from_grabcut(
            loaded.rgb,
            args.rect,
            args.foreground_point,
            args.background_point,
            args.foreground_region,
            args.background_region,
            args.foreground_polygon,
            args.background_polygon,
            args.point_radius,
            args.foreground_mask,
            args.background_mask,
            args.max_bytes,
        )
    elif has_useful_alpha and args.mode == "auto":
        route = "existing-alpha"
        alpha = loaded.alpha
    elif args.mode == "auto":
        raise CutoutError(
            "guidance-required",
            "The invoking agent must inspect the image and choose --mode background or provide GrabCut guidance",
        )
    else:
        estimate = estimate_background(loaded.rgb)
        route = estimate.route
        alpha, background_distance_low, background_distance_high = alpha_from_background(
            estimate,
            args.background_tolerance,
        )

    if args.opaque_subject:
        output_rgb, alpha, modified_pixels = refine_opaque_subject(
            loaded.rgb,
            alpha,
            foreground_threshold,
            edge_inset,
            64,
            min_component_area,
        )
    elif args.decontaminate_edges and route in ("solid-background", "gradient-background"):
        output_rgb, modified_pixels = decontaminate(loaded.rgb, alpha, estimate)
    else:
        output_rgb, modified_pixels = loaded.rgb.copy(), 0
    rgba = np.dstack((output_rgb, alpha))
    metrics, warning_codes, status = quality_metrics(
        alpha,
        modified_pixels,
        estimate.residual_p95 if estimate is not None else None,
    )
    if background_distance_low is not None and background_distance_high is not None:
        metrics["backgroundDistanceLow"] = round(background_distance_low, 3)
        metrics["backgroundDistanceHigh"] = round(background_distance_high, 3)
    if args.opaque_subject:
        metrics["opaqueSubjectRefinement"] = True
        metrics["foregroundThreshold"] = foreground_threshold
        metrics["edgeInset"] = edge_inset
        metrics["minComponentArea"] = min_component_area
    if route == "guided-grabcut":
        status = "review"
        warning_codes.append("guided-result-requires-visual-review")
    elif route in ("solid-background", "gradient-background"):
        status = "review"
        warning_codes.append("background-assumption-requires-visual-review")
    source_rgb_preserved = modified_pixels == 0
    normalized_size = {"width": loaded.width, "height": loaded.height}
    del alpha, estimate, loaded, output_rgb
    artifacts = save_artifacts(artifacts_directory, rgba) if artifacts_directory else {}
    save_png_atomic(Image.fromarray(rgba, "RGBA"), output_path)
    return {
        "status": status,
        "route": route,
        "subject": subject,
        "guidance": {
            "rectangleCount": len(args.rect),
            "foregroundRegionCount": len(args.foreground_region),
            "backgroundRegionCount": len(args.background_region),
            "foregroundPolygonCount": len(args.foreground_polygon),
            "backgroundPolygonCount": len(args.background_polygon),
            "foregroundPointCount": len(args.foreground_point),
            "backgroundPointCount": len(args.background_point),
            "foregroundMask": args.foreground_mask is not None,
            "backgroundMask": args.background_mask is not None,
        },
        "inputPath": str(input_path),
        "outputPath": str(output_path),
        "normalizedSize": normalized_size,
        "sourceRgbPreserved": source_rgb_preserved,
        "metrics": metrics,
        "warnings": sorted(set(warning_codes)),
        "artifacts": artifacts,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
    }


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        result = run(args)
    except CutoutError as error:
        result = {"status": "error", "error": {"code": error.code, "message": str(error)}}
    except Exception as error:
        result = {"status": "error", "error": {"code": "processing-failed", "message": str(error)}}
    else:
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(f"{result['status']}: {result['outputPath']}")
        return 0
    print(json.dumps(result, ensure_ascii=False))
    return 2


if __name__ == "__main__":
    sys.exit(main())
