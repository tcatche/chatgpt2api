from __future__ import annotations

import base64
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.image_tasks as image_tasks_module


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}
PNG_BYTES = b"\x89PNG\r\n\x1a\n"
DATA_IMAGE_URL = f"data:image/png;base64,{base64.b64encode(PNG_BYTES).decode('ascii')}"


class FakeImageTaskService:
    def __init__(self):
        self.generation_calls = []
        self.edit_calls = []
        self.batch_calls = []

    def submit_generation(self, identity, **kwargs):
        self.generation_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "success",
            "mode": "generate",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
            "data": [{"url": f"{kwargs['base_url']}/images/fake.png"}],
        }

    def submit_edit(self, identity, **kwargs):
        self.edit_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "queued",
            "mode": "edit",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def submit_batch(self, identity, *, items, base_url=""):
        self.batch_calls.append((identity, items, base_url))
        return [
            {
                "id": item["client_task_id"],
                "status": "queued",
                "mode": item["mode"],
                "created_at": "2026-01-01 00:00:00",
                "updated_at": "2026-01-01 00:00:00",
            }
            for item in items
        ]

    def list_tasks(self, _identity, ids):
        return {
            "items": [
                {
                    "id": task_id,
                    "status": "success",
                    "mode": "generate",
                    "created_at": "2026-01-01 00:00:00",
                    "updated_at": "2026-01-01 00:00:00",
                    "data": [{"url": "http://testserver/images/fake.png"}],
                }
                for task_id in ids
                if task_id != "missing"
            ],
            "missing_ids": [task_id for task_id in ids if task_id == "missing"],
        }


class ImageTasksApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakeImageTaskService()
        self.service_patcher = mock.patch.object(image_tasks_module, "image_task_service", self.fake_service)
        self.identity_patcher = mock.patch.object(
            image_tasks_module,
            "require_identity",
            return_value={"id": "test", "name": "Test", "role": "admin"},
        )
        self.service_patcher.start()
        self.identity_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.addCleanup(self.identity_patcher.stop)
        app = FastAPI()
        app.include_router(image_tasks_module.create_router())
        self.client = TestClient(app)

    def test_create_generation_task(self):
        response = self.client.post(
            "/api/image-tasks/generations",
            headers=AUTH_HEADERS,
            json={"client_task_id": "task-1", "prompt": "cat", "model": "gpt-image-2"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["id"], "task-1")
        self.assertEqual(payload["status"], "success")
        self.assertEqual(len(self.fake_service.generation_calls), 1)

    def test_create_generation_task_uses_configured_default_model(self):
        with mock.patch.dict(image_tasks_module.config.data, {
            "custom_image_models": ["custom-image-v1"],
            "default_image_model": "custom-image-v1",
        }):
            response = self.client.post(
                "/api/image-tasks/generations",
                headers=AUTH_HEADERS,
                json={"client_task_id": "task-default-model", "prompt": "cat"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.fake_service.generation_calls[0][1]["model"], "custom-image-v1")

    def test_create_edit_task_accepts_multiple_images(self):
        """测试图片编辑任务接口支持多个上传图片。"""
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={"client_task_id": "edit-1", "prompt": "edit", "model": "gpt-image-2"},
            files=[
                ("image", ("one.png", b"one", "image/png")),
                ("image", ("two.png", b"two", "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "edit-1")
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(len(images), 2)

    def test_create_edit_task_forwards_annotation_mask(self):
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={"client_task_id": "edit-mask-1", "prompt": "replace marked area"},
            files=[
                ("image", ("source.png", b"source", "image/png")),
                ("mask", ("mask.png", b"mask", "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 200, response.text)
        call = self.fake_service.edit_calls[0][1]
        self.assertEqual(call["images"], [(b"source", "source.png", "image/png")])
        self.assertEqual(call["masks"], [(b"mask", "mask.png", "image/png")])

    def test_create_edit_task_accepts_image_url(self):
        """测试图片编辑任务接口支持表单 image_url 引用。"""
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={
                "client_task_id": "edit-url-1",
                "prompt": "edit",
                "model": "gpt-image-2",
                "image_url": DATA_IMAGE_URL,
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(images, [(PNG_BYTES, "image_url.png", "image/png")])

    def test_list_tasks_reports_missing_ids(self):
        response = self.client.get("/api/image-tasks?ids=task-1,missing", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["items"]], ["task-1"])
        self.assertEqual(payload["missing_ids"], ["missing"])

    def test_create_batch_tasks_parses_reference_urls(self):
        response = self.client.post(
            "/api/image-tasks/batch",
            headers=AUTH_HEADERS,
            json={
                "tasks": [
                    {
                        "client_task_id": "batch-1",
                        "mode": "edit",
                        "prompt": "make it blue",
                        "model": "gpt-image-2",
                        "reference_urls": [
                            "https://webdav-r2.vvooo.top/chatgpt2api/images/inputs/2026/10/27/a.jpg?token=1",
                        ],
                        "mask_urls": ["/images/inputs/2026/10/27/mask.png"],
                    },
                    {
                        "client_task_id": "batch-2",
                        "mode": "generate",
                        "prompt": "a cat",
                    },
                ]
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([task["id"] for task in response.json()["tasks"]], ["batch-1", "batch-2"])
        _, items, _ = self.fake_service.batch_calls[0]
        self.assertEqual(items[0]["reference_paths"], ["inputs/2026/10/27/a.jpg"])
        self.assertEqual(items[0]["mask_paths"], ["inputs/2026/10/27/mask.png"])
        self.assertEqual(items[0]["mode"], "edit")
        self.assertEqual(items[1]["mode"], "generate")

    def test_create_batch_tasks_rejects_more_than_100(self):
        response = self.client.post(
            "/api/image-tasks/batch",
            headers=AUTH_HEADERS,
            json={
                "tasks": [
                    {"client_task_id": f"batch-{index}", "prompt": "cat"}
                    for index in range(101)
                ]
            },
        )

        self.assertEqual(response.status_code, 422)

    def test_storage_rel_from_url(self):
        self.assertEqual(
            image_tasks_module._storage_rel_from_url(
                "https://webdav-r2.vvooo.top/chatgpt2api/images/inputs/2026/10/27/a.jpg?x=1#y"
            ),
            "inputs/2026/10/27/a.jpg",
        )
        self.assertEqual(
            image_tasks_module._storage_rel_from_url("https://image2.vvooo.top/images/2026/10/27/b.png"),
            "2026/10/27/b.png",
        )
        self.assertEqual(
            image_tasks_module._storage_rel_from_url("/images/inputs/2026/10/27/c.webp"),
            "inputs/2026/10/27/c.webp",
        )
        self.assertEqual(image_tasks_module._storage_rel_from_url("https://example.test/no-image.png"), "")

    def test_storage_rel_from_url_uses_public_base_prefix(self):
        with mock.patch.object(
            image_tasks_module.config,
            "get_image_storage_settings",
            return_value={"public_base_url": "https://cdn.example.com"},
        ):
            self.assertEqual(
                image_tasks_module._storage_rel_from_url("https://cdn.example.com/inputs/2026/10/27/a.jpg"),
                "inputs/2026/10/27/a.jpg",
            )


if __name__ == "__main__":
    unittest.main()
