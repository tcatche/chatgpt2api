from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.image_conversations import create_router
from services import image_conversation_service as svc_mod
from services.config import config


def turn(turn_id: str = "t1", status: str = "success") -> dict:
    return {
        "id": turn_id,
        "prompt": "a red fox",
        "model": "gpt-image-2",
        "mode": "generate",
        "referenceImages": [
            {"name": "ref.png", "type": "image/png", "dataUrl": "data:image/png;base64,AAAA"}
        ],
        "maskImages": [],
        "count": 1,
        "size": "1024x1024",
        "ratio": "1:1",
        "tier": "1k",
        "quality": "auto",
        "images": [{"id": "img-1", "status": "success", "url": "/images/a.png"}],
        "createdAt": "2026-10-13T00:00:00.000Z",
        "status": status,
    }


def conversation(conversation_id: str = "c1", updated_at: str = "2026-10-13T01:00:00.000Z") -> dict:
    return {
        "id": conversation_id,
        "title": "会话",
        "model": "gpt-image-2",
        "createdAt": "2026-10-13T00:00:00.000Z",
        "updatedAt": updated_at,
        "turns": [turn()],
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

    def test_save_list_detail_rename_delete_clear_round_trip(self):
        # 保存返回最小确认（不再返回整份列表）
        saved = self.client.post(
            "/api/image-conversations",
            json={"conversations": [conversation()]},
            headers=self.headers,
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json(), {"ok": True, "count": 1})

        # 列表是轻量摘要：有 turnCount/stats，不含 turns / base64
        listed = self.client.get("/api/image-conversations", headers=self.headers)
        self.assertEqual(listed.status_code, 200)
        items = listed.json()["items"]
        self.assertEqual(len(items), 1)
        summary = items[0]
        self.assertEqual(summary["id"], "c1")
        self.assertEqual(summary["turnCount"], 1)
        self.assertEqual(summary["stats"], {"queued": 0, "running": 0})
        self.assertNotIn("turns", summary)
        self.assertNotIn("owner_id", summary)
        self.assertNotIn("dataUrl", listed.text)

        # 详情返回完整内容（含参考图 base64）
        detail = self.client.get("/api/image-conversations/c1", headers=self.headers)
        self.assertEqual(detail.status_code, 200)
        full = detail.json()["conversation"]
        self.assertEqual(full["turns"][0]["prompt"], "a red fox")
        self.assertEqual(full["turns"][0]["referenceImages"][0]["dataUrl"], "data:image/png;base64,AAAA")

        # 缺失的会话 → 404
        self.assertEqual(self.client.get("/api/image-conversations/nope", headers=self.headers).status_code, 404)

        # 重命名 / 删除 / 清空都返回最小确认
        self.assertEqual(
            self.client.post(
                "/api/image-conversations/c1/rename", json={"title": "新名字"}, headers=self.headers
            ).json(),
            {"ok": True},
        )
        renamed = self.client.get("/api/image-conversations", headers=self.headers).json()["items"][0]
        self.assertEqual(renamed["title"], "新名字")

        self.assertEqual(
            self.client.delete("/api/image-conversations/c1", headers=self.headers).json(),
            {"ok": True},
        )
        self.assertEqual(self.client.get("/api/image-conversations", headers=self.headers).json()["items"], [])

        self.client.post(
            "/api/image-conversations",
            json={"conversations": [conversation("c2")]},
            headers=self.headers,
        )
        self.assertEqual(
            self.client.delete("/api/image-conversations", headers=self.headers).json(),
            {"ok": True},
        )
        self.assertEqual(self.client.get("/api/image-conversations", headers=self.headers).json()["items"], [])

    def test_requires_authorization(self):
        self.assertEqual(self.client.get("/api/image-conversations").status_code, 401)
        self.assertEqual(self.client.get("/api/image-conversations/c1").status_code, 401)


if __name__ == "__main__":
    unittest.main()
