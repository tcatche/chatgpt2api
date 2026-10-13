from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from services.image_conversation_service import ImageConversationService


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER = {"id": "owner-2", "name": "Other", "role": "user"}


def conversation(conversation_id: str, updated_at: str, title: str = "会话") -> dict:
    return {
        "id": conversation_id,
        "title": title,
        "model": "gpt-image-2",
        "createdAt": "2026-10-13T00:00:00.000Z",
        "updatedAt": updated_at,
        "turns": [
            {
                "id": f"{conversation_id}-turn",
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
                "status": "success",
            }
        ],
    }


class ImageConversationServiceTests(unittest.TestCase):
    def make_service(self, path: Path) -> ImageConversationService:
        return ImageConversationService(path)

    def test_save_and_list_are_scoped_to_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            service.save_conversations(OWNER, [conversation("c1", "2026-10-13T01:00:00.000Z")])

            owner_items = service.list_conversations(OWNER)["items"]
            self.assertEqual([item["id"] for item in owner_items], ["c1"])
            self.assertNotIn("owner_id", owner_items[0])
            self.assertEqual(owner_items[0]["turns"][0]["prompt"], "a red fox")
            self.assertEqual(owner_items[0]["turns"][0]["referenceImages"][0]["dataUrl"], "data:image/png;base64,AAAA")
            self.assertEqual(service.list_conversations(OTHER)["items"], [])

    def test_stale_write_does_not_overwrite_newer(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            service.save_conversations(OWNER, [conversation("c1", "2026-10-13T02:00:00.000Z", title="new")])
            service.save_conversations(OWNER, [conversation("c1", "2026-10-13T01:00:00.000Z", title="old")])

            items = service.list_conversations(OWNER)["items"]
            self.assertEqual(items[0]["title"], "new")

    def test_rename_updates_title_and_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            service.save_conversations(
                OWNER,
                [
                    conversation("c1", "2026-10-13T01:00:00.000Z"),
                    conversation("c2", "2026-10-13T02:00:00.000Z"),
                ],
            )
            result = service.rename_conversation(OWNER, "c1", "重命名")
            titles = {item["id"]: item["title"] for item in result["items"]}
            self.assertEqual(titles["c1"], "重命名")
            self.assertEqual(result["items"][0]["id"], "c1")

    def test_delete_and_clear_only_affect_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            service.save_conversations(OWNER, [conversation("c1", "2026-10-13T01:00:00.000Z")])
            service.save_conversations(OTHER, [conversation("c9", "2026-10-13T01:00:00.000Z")])

            service.delete_conversation(OWNER, "c1")
            self.assertEqual(service.list_conversations(OWNER)["items"], [])
            self.assertEqual([item["id"] for item in service.list_conversations(OTHER)["items"]], ["c9"])

            service.save_conversations(OWNER, [conversation("c2", "2026-10-13T03:00:00.000Z")])
            service.clear_conversations(OWNER)
            self.assertEqual(service.list_conversations(OWNER)["items"], [])
            self.assertEqual(len(service.list_conversations(OTHER)["items"]), 1)

    def test_conversations_survive_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image_conversations.json"
            service = self.make_service(path)
            service.save_conversations(OWNER, [conversation("c1", "2026-10-13T01:00:00.000Z")])

            reloaded = self.make_service(path)
            items = reloaded.list_conversations(OWNER)["items"]
            self.assertEqual([item["id"] for item in items], ["c1"])
            self.assertEqual(items[0]["turns"][0]["images"][0]["url"], "/images/a.png")


if __name__ == "__main__":
    unittest.main()
