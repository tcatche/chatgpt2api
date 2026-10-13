from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.image_conversations import create_router
from services import image_conversation_service as svc_mod
from services.config import config


def conversation(conversation_id: str = "c1", updated_at: str = "2026-10-13T01:00:00.000Z") -> dict:
    return {
        "id": conversation_id,
        "title": "会话",
        "model": "gpt-image-2",
        "createdAt": "2026-10-13T00:00:00.000Z",
        "updatedAt": updated_at,
        "turns": [
            {
                "id": f"{conversation_id}-turn",
                "prompt": "a red fox",
                "model": "gpt-image-2",
                "mode": "generate",
                "referenceImages": [],
                "maskImages": [],
                "count": 1,
                "size": "1024x1024",
                "ratio": "1:1",
                "tier": "1k",
                "quality": "auto",
                "images": [{"id": "img-1", "status": "success", "url": "/images/a.png"}],
                "createdAt": "2026-10-13T00:00:00.000Z",
                "status": "success",
            }
        ],
    }


class ImageConversationsApiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        svc_mod.image_conversation_service.path = Path(self._tmp.name) / "image_conversations.json"
        svc_mod.image_conversation_service._items = {}
        app = FastAPI()
        app.include_router(create_router())
        self.client = TestClient(app)
        self.headers = {"Authorization": f"Bearer {config.auth_key}"}

    def test_save_list_rename_delete_clear_round_trip(self):
        # 保存（请求体是对象，验证不会被当成 query 参数）
        saved = self.client.post(
            "/api/image-conversations",
            json={"conversations": [conversation()]},
            headers=self.headers,
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual([item["id"] for item in saved.json()["items"]], ["c1"])

        # 列出：不泄漏 owner_id，保留 prompt
        listed = self.client.get("/api/image-conversations", headers=self.headers)
        self.assertEqual(listed.status_code, 200)
        items = listed.json()["items"]
        self.assertEqual([item["id"] for item in items], ["c1"])
        self.assertNotIn("owner_id", items[0])
        self.assertEqual(items[0]["turns"][0]["prompt"], "a red fox")

        # 重命名
        renamed = self.client.post(
            "/api/image-conversations/c1/rename",
            json={"title": "新名字"},
            headers=self.headers,
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()["items"][0]["title"], "新名字")

        # 删除单条
        deleted = self.client.delete("/api/image-conversations/c1", headers=self.headers)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["items"], [])

        # 清空（先再存一条）
        self.client.post(
            "/api/image-conversations",
            json={"conversations": [conversation("c2")]},
            headers=self.headers,
        )
        cleared = self.client.delete("/api/image-conversations", headers=self.headers)
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(cleared.json()["items"], [])

    def test_requires_authorization(self):
        response = self.client.get("/api/image-conversations")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
