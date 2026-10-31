from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from services import image_service


class ThumbnailTests(unittest.TestCase):
    def make_workspace(self, root: Path) -> tuple[Path, Path]:
        images = root / "images"
        thumbs = root / "thumbs"
        images.mkdir(parents=True, exist_ok=True)
        source = images / "2026" / "10" / "30" / "sample.webp"
        source.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (1200, 800), color=(30, 120, 200)).save(source, format="WEBP", quality=90)
        return images, thumbs

    def patch_config(self, images: Path, thumbs: Path, exists: bool = True):
        config_patcher = mock.patch("services.image_service.config")
        storage_patcher = mock.patch("services.image_service.image_storage_service")
        config_mock = config_patcher.start()
        storage_mock = storage_patcher.start()
        self.addCleanup(config_patcher.stop)
        self.addCleanup(storage_patcher.stop)
        config_mock.images_dir = images
        config_mock.image_thumbnails_dir = thumbs
        storage_mock.has_local.return_value = True
        storage_mock.exists.return_value = exists
        return config_mock, storage_mock

    def test_thumbnail_is_bounded_webp(self):
        with tempfile.TemporaryDirectory() as tmp:
            images, thumbs = self.make_workspace(Path(tmp))
            self.patch_config(images, thumbs)

            target = image_service.ensure_thumbnail("2026/10/30/sample.webp")

            self.assertTrue(target.name.endswith(".webp"))
            self.assertEqual(target.parent, thumbs / "2026" / "10" / "30")
            with Image.open(target) as image:
                self.assertEqual(image.format, "WEBP")
                self.assertLessEqual(max(image.size), 480)

    def test_cleanup_drops_legacy_png_thumbnails(self):
        with tempfile.TemporaryDirectory() as tmp:
            images, thumbs = self.make_workspace(Path(tmp))
            self.patch_config(images, thumbs)
            image_service.ensure_thumbnail("2026/10/30/sample.webp")
            legacy = thumbs / "2026" / "10" / "30" / "sample.webp.png"
            legacy.write_bytes(b"legacy")

            removed = image_service.cleanup_image_thumbnails()

            self.assertFalse(legacy.exists())
            self.assertTrue((thumbs / "2026" / "10" / "30" / "sample.webp.webp").exists())
            self.assertEqual(removed, 1)


if __name__ == "__main__":
    unittest.main()
