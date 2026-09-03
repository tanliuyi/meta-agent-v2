from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "cutout.py"
SPEC = importlib.util.spec_from_file_location("cutout", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
CUTOUT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CUTOUT
SPEC.loader.exec_module(CUTOUT)


class CutoutTest(unittest.TestCase):
    def test_existing_alpha_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pixels = np.zeros((12, 10, 4), dtype=np.uint8)
            pixels[:, :, :3] = (10, 20, 30)
            pixels[3:9, 2:8, 3] = 255
            source = root / "source.png"
            output = root / "output.png"
            Image.fromarray(pixels, "RGBA").save(source)

            args = CUTOUT.build_parser().parse_args(["--input", str(source), "--output", str(output)])
            result = CUTOUT.run(args)

            actual = np.asarray(Image.open(output).convert("RGBA"))
            np.testing.assert_array_equal(actual, pixels)
            self.assertEqual(result["route"], "existing-alpha")
            self.assertTrue(result["sourceRgbPreserved"])

    def test_solid_background_cutout_preserves_opaque_subject(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = np.full((80, 100, 3), 245, dtype=np.uint8)
            rgb[20:65, 25:75] = (180, 30, 40)
            source = root / "source.png"
            output = root / "output.png"
            artifacts = root / "artifacts"
            Image.fromarray(rgb, "RGB").save(source)

            args = CUTOUT.build_parser().parse_args(
                [
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--mode",
                    "background",
                    "--background-tolerance",
                    "36",
                    "--opaque-subject",
                    "--subject",
                    "red rectangle",
                    "--artifacts-dir",
                    str(artifacts),
                ]
            )
            result = CUTOUT.run(args)

            actual = np.asarray(Image.open(output).convert("RGBA"))
            self.assertEqual(actual.shape, (80, 100, 4))
            self.assertEqual(int(actual[0, 0, 3]), 0)
            self.assertEqual(int(actual[40, 50, 3]), 255)
            np.testing.assert_array_equal(actual[40, 50, :3], rgb[40, 50])
            self.assertEqual(result["route"], "solid-background")
            self.assertEqual(result["metrics"]["backgroundDistanceHigh"], 36.0)
            self.assertGreater(result["metrics"]["backgroundDistanceHigh"], result["metrics"]["backgroundDistanceLow"])
            self.assertTrue(result["metrics"]["opaqueSubjectRefinement"])
            self.assertTrue((artifacts / "alpha.png").is_file())
            self.assertTrue((artifacts / "trimap.png").is_file())
            self.assertTrue((artifacts / "preview-light.png").is_file())
            self.assertTrue((artifacts / "preview-dark.png").is_file())
            self.assertTrue((artifacts / "preview-checker.png").is_file())
            light_preview = np.asarray(Image.open(artifacts / "preview-light.png").convert("RGB"))
            dark_preview = np.asarray(Image.open(artifacts / "preview-dark.png").convert("RGB"))
            np.testing.assert_array_equal(light_preview[0, 0], (255, 255, 255))
            np.testing.assert_array_equal(dark_preview[0, 0], (24, 24, 24))

    def test_gradient_background_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            x = np.linspace(40, 220, 120, dtype=np.uint8)
            rgb = np.broadcast_to(x[None, :, None], (90, 120, 3)).copy()
            rgb[25:70, 40:85] = (20, 170, 60)
            source = root / "source.png"
            output = root / "output.png"
            artifacts = root / "artifacts"
            Image.fromarray(rgb, "RGB").save(source)

            args = CUTOUT.build_parser().parse_args(
                [
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--mode",
                    "background",
                    "--subject",
                    "green rectangle",
                    "--artifacts-dir",
                    str(artifacts),
                ]
            )
            result = CUTOUT.run(args)

            actual = np.asarray(Image.open(output).convert("RGBA"))
            self.assertEqual(result["route"], "gradient-background")
            self.assertIn("backgroundResidualP95", result["metrics"])
            self.assertLess(int(actual[10, 10, 3]), 16)
            self.assertEqual(int(actual[45, 60, 3]), 255)

    def test_auto_guidance_uses_grabcut_and_requires_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = np.full((100, 120, 3), (30, 70, 180), dtype=np.uint8)
            rgb[25:80, 35:90] = (210, 40, 30)
            source = root / "source.png"
            output = root / "output.png"
            artifacts = root / "artifacts"
            Image.fromarray(rgb, "RGB").save(source)

            args = CUTOUT.build_parser().parse_args(
                [
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--subject",
                    "red rectangle",
                    "--rect",
                    "30,20,65,65",
                    "--rect",
                    "40,30,10,10",
                    "--foreground-region",
                    "55,45,4,4",
                    "--background-region",
                    "45,40,5,5",
                    "--foreground-polygon",
                    "55,45;58,45;58,49;55,49",
                    "--background-polygon",
                    "46,41;49,41;49,44;46,44",
                    "--foreground-point",
                    "60,50",
                    "--background-point",
                    "5,5",
                    "--artifacts-dir",
                    str(artifacts),
                ]
            )
            result = CUTOUT.run(args)

            actual = np.asarray(Image.open(output).convert("RGBA"))
            self.assertEqual(result["route"], "guided-grabcut")
            self.assertEqual(result["status"], "review")
            self.assertEqual(result["subject"], "red rectangle")
            self.assertEqual(result["guidance"]["rectangleCount"], 2)
            self.assertEqual(result["guidance"]["foregroundRegionCount"], 1)
            self.assertEqual(result["guidance"]["backgroundRegionCount"], 1)
            self.assertEqual(result["guidance"]["foregroundPolygonCount"], 1)
            self.assertEqual(result["guidance"]["backgroundPolygonCount"], 1)
            self.assertEqual(result["guidance"]["foregroundPointCount"], 1)
            self.assertEqual(result["guidance"]["backgroundPointCount"], 1)
            self.assertIn("guided-result-requires-visual-review", result["warnings"])
            self.assertLess(int(actual[5, 5, 3]), 32)
            self.assertEqual(int(actual[42, 47, 3]), 0)
            self.assertEqual(int(actual[46, 56, 3]), 255)
            self.assertGreater(int(actual[50, 60, 3]), 224)

    def test_masks_initialize_grabcut_before_segmentation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rgb = np.full((80, 90, 3), (25, 65, 170), dtype=np.uint8)
            rgb[20:65, 25:70] = (205, 45, 35)
            foreground = np.zeros((80, 90), dtype=np.uint8)
            foreground[35:50, 40:55] = 255
            foreground[20, 24] = 255
            background = np.zeros((80, 90), dtype=np.uint8)
            background[20, 25] = 255
            background[:5, :] = 255
            background[-5:, :] = 255
            background[:, :5] = 255
            background[:, -5:] = 255
            source = root / "source.png"
            foreground_path = root / "foreground.png"
            background_path = root / "background.png"
            output = root / "output.png"
            artifacts = root / "artifacts"
            Image.fromarray(rgb, "RGB").save(source)
            Image.fromarray(foreground, "L").save(foreground_path)
            Image.fromarray(background, "L").save(background_path)

            args = CUTOUT.build_parser().parse_args(
                [
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--mode",
                    "grabcut",
                    "--subject",
                    "red rectangle",
                    "--rect",
                    "0,0,90,80",
                    "--foreground-mask",
                    str(foreground_path),
                    "--background-mask",
                    str(background_path),
                    "--artifacts-dir",
                    str(artifacts),
                ]
            )
            result = CUTOUT.run(args)

            actual = np.asarray(Image.open(output).convert("RGBA"))
            self.assertEqual(result["route"], "guided-grabcut")
            self.assertTrue(np.all(actual[:, :, 3][foreground > 0] == 255))
            self.assertTrue(np.all(actual[:, :, 3][background > 0] == 0))
            self.assertLess(int(actual[2, 2, 3]), 32)
            self.assertGreater(int(actual[42, 47, 3]), 224)

    def test_auto_requires_agent_guidance_for_opaque_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            Image.new("RGB", (100, 100), (190, 30, 40)).save(source)

            args = CUTOUT.build_parser().parse_args(["--input", str(source), "--output", str(output)])
            with self.assertRaises(CUTOUT.CutoutError) as caught:
                CUTOUT.run(args)

            self.assertEqual(caught.exception.code, "guidance-required")
            self.assertFalse(output.exists())

    def test_generated_alpha_requires_subject_description(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            Image.new("RGB", (20, 20), "white").save(source)

            args = CUTOUT.build_parser().parse_args(
                ["--input", str(source), "--output", str(output), "--mode", "background"]
            )
            with self.assertRaises(CUTOUT.CutoutError) as caught:
                CUTOUT.run(args)

            self.assertEqual(caught.exception.code, "subject-required")
            self.assertFalse(output.exists())

    def test_generated_alpha_requires_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            Image.new("RGB", (20, 20), "white").save(source)

            args = CUTOUT.build_parser().parse_args(
                [
                    "--input",
                    str(source),
                    "--output",
                    str(output),
                    "--mode",
                    "background",
                    "--subject",
                    "white square",
                ]
            )
            with self.assertRaises(CUTOUT.CutoutError) as caught:
                CUTOUT.run(args)

            self.assertEqual(caught.exception.code, "artifacts-required")
            self.assertFalse(output.exists())

    def test_hard_link_output_alias_is_rejected_without_modifying_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            Image.new("RGB", (20, 20), "white").save(source)
            original = source.read_bytes()
            os.link(source, output)

            args = CUTOUT.build_parser().parse_args(["--input", str(source), "--output", str(output)])
            with self.assertRaises(CUTOUT.CutoutError) as caught:
                CUTOUT.run(args)

            self.assertEqual(caught.exception.code, "invalid-output")
            self.assertEqual(source.read_bytes(), original)

    def test_hard_link_artifact_alias_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            artifacts = root / "artifacts"
            artifacts.mkdir()
            Image.new("RGB", (20, 20), "white").save(source)
            original = source.read_bytes()
            os.link(source, artifacts / "alpha.png")

            args = CUTOUT.build_parser().parse_args(
                ["--input", str(source), "--output", str(output), "--artifacts-dir", str(artifacts)]
            )
            with self.assertRaises(CUTOUT.CutoutError) as caught:
                CUTOUT.run(args)

            self.assertEqual(caught.exception.code, "invalid-output")
            self.assertEqual(source.read_bytes(), original)
            self.assertFalse(output.exists())

    def test_symbolic_link_output_alias_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            Image.new("RGBA", (20, 20), (10, 20, 30, 0)).save(source)
            try:
                output.symlink_to(source)
            except OSError as error:
                self.skipTest(f"Symbolic links are unavailable: {error}")

            args = CUTOUT.build_parser().parse_args(["--input", str(source), "--output", str(output)])
            with self.assertRaises(CUTOUT.CutoutError):
                CUTOUT.run(args)

    def test_symbolic_link_artifact_alias_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            artifacts = root / "artifacts"
            artifacts.mkdir()
            Image.new("RGBA", (20, 20), (10, 20, 30, 0)).save(source)
            try:
                (artifacts / "alpha.png").symlink_to(source)
            except OSError as error:
                self.skipTest(f"Symbolic links are unavailable: {error}")

            args = CUTOUT.build_parser().parse_args(
                ["--input", str(source), "--output", str(output), "--artifacts-dir", str(artifacts)]
            )
            with self.assertRaises(CUTOUT.CutoutError) as caught:
                CUTOUT.run(args)

            self.assertEqual(caught.exception.code, "invalid-output")
            self.assertFalse(output.exists())

    def test_opaque_subject_refinement_solidifies_interior_and_keeps_tiny_components(self) -> None:
        rgb = np.full((9, 9, 3), (10, 90, 60), dtype=np.uint8)
        rgb[3:6, 3:6] = (180, 30, 40)
        rgb[0, 8] = (220, 180, 40)
        alpha = np.zeros((9, 9), dtype=np.uint8)
        alpha[2:7, 2:7] = 180
        alpha[3:6, 3:6] = 255
        alpha[4, 4] = 0
        alpha[0, 8] = 255

        refined_rgb, refined_alpha, modified = CUTOUT.refine_opaque_subject(rgb, alpha)

        self.assertEqual(int(refined_alpha[4, 4]), 255)
        self.assertEqual(int(refined_alpha[0, 8]), 255)
        self.assertEqual(int(refined_alpha[0, 0]), 0)
        self.assertGreater(int(refined_alpha[2, 4]), 0)
        np.testing.assert_array_equal(refined_rgb[4, 4], rgb[4, 4])
        self.assertGreater(modified, 0)

    def test_opaque_subject_min_component_area_filters_confirmed_noise(self) -> None:
        rgb = np.full((20, 20, 3), (10, 90, 60), dtype=np.uint8)
        rgb[4:16, 4:16] = (180, 30, 40)
        rgb[1, 1] = (220, 180, 40)
        alpha = np.zeros((20, 20), dtype=np.uint8)
        alpha[4:16, 4:16] = 255
        alpha[1, 1] = 255

        _, refined_alpha, _ = CUTOUT.refine_opaque_subject(rgb, alpha, 128, 0, 64, 32)

        self.assertEqual(int(refined_alpha[10, 10]), 255)
        self.assertEqual(int(refined_alpha[1, 1]), 0)

        rgb = np.array([[[240, 240, 240], [220, 120, 120], [180, 30, 40]]], dtype=np.uint8)
        alpha = np.array([[0, 128, 255]], dtype=np.uint8)
        estimate = CUTOUT.BackgroundEstimate(
            distance=np.zeros((1, 3), dtype=np.float32),
            route="solid-background",
            residual_p95=0.0,
            solid_rgb=np.full(3, 240, dtype=np.float32),
            gradient_coefficients=None,
        )

        result, modified = CUTOUT.decontaminate(rgb, alpha, estimate)

        np.testing.assert_array_equal(result[0, 0], rgb[0, 0])
        np.testing.assert_array_equal(result[0, 2], rgb[0, 2])
        self.assertFalse(np.array_equal(result[0, 1], rgb[0, 1]))
        self.assertEqual(modified, 1)

    def test_cli_errors_are_json(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--json"],
            check=False,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid-arguments")
        self.assertEqual(completed.stderr, "")

    def test_pixel_limit_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (20, 20), "white").save(source)
            with self.assertRaises(CUTOUT.CutoutError) as caught:
                CUTOUT.load_image(source, 1024 * 1024, 399)
            self.assertEqual(caught.exception.code, "resource-limit")

    def test_cli_emits_single_json_object(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "output.png"
            Image.new("RGBA", (16, 16), (50, 70, 90, 0)).save(source)
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(source), "--output", str(output), "--json"],
                check=True,
                capture_output=True,
                text=True,
            )
            result = json.loads(completed.stdout)
            self.assertIn(result["status"], ("pass", "review"))
            self.assertEqual(result["normalizedSize"], {"width": 16, "height": 16})
            self.assertEqual(completed.stderr, "")


if __name__ == "__main__":
    unittest.main()
