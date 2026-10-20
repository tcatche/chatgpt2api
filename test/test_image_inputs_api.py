from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.image_inputs import create_router
from services.config import config
from services.image_storage_service import StoredImage


class ImageInputsApiTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(create_router())
        self.client = TestClient(app)
        self.headers = {"Authorization": f"Bearer {config.auth_key}"}

    def test_upload_image_input_returns_url(self):
        stored = StoredImage(rel="inputs/1.png", url="https://cdn.test/inputs/1.png", storage="local", size=3)
        with mock.patch(
            "api.image_inputs.image_storage_service.save_input",
            return_value=stored,
        ) as save_input:
            response = self.client.post(
                "/api/image-inputs",
                files={"file": ("ref.png", b"abc", "image/png")},
                headers=self.headers,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"url": "https://cdn.test/inputs/1.png", "name": "ref.png", "type": "image/png"},
        )
        save_input.assert_called_once()

    def test_upload_requires_authorization(self):
        response = self.client.post(
            "/api/image-inputs",
            files={"file": ("ref.png", b"abc", "image/png")},
        )
        self.assertEqual(response.status_code, 401)

    def test_upload_rejects_non_image(self):
        response = self.client.post(
            "/api/image-inputs",
            files={"file": ("note.txt", b"hello", "text/plain")},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)

    def test_upload_rejects_unsupported_image_type(self):
        response = self.client.post(
            "/api/image-inputs",
            files={"file": ("vector.svg", b"<svg/>", "image/svg+xml")},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)

    def test_upload_rejects_empty_file(self):
        response = self.client.post(
            "/api/image-inputs",
            files={"file": ("ref.png", b"", "image/png")},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
