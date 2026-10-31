from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from services.image_conversation_service import ImageConversationService


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER = {"id": "owner-2", "name": "Other", "role": "user"}


def turn(turn_id: str, status: str = "success", *, results_deleted: bool = False) -> dict:
    return {
        "id": turn_id,
        "prompt": "a red fox",
        "model": "gpt-image-2",
        "mode": "generate",
        "referenceImages": [
            {"name": "ref.png", "type": "image/png", "dataUrl": "data:image/png;base64,AAAA"}
        ],
        "maskImages": [{"name": "mask.png", "type": "image/png", "dataUrl": "data:image/png;base64,BBBB"}],
        "count": 1,
        "size": "1024x1024",
        "ratio": "1:1",
        "tier": "1k",
        "quality": "auto",
        "images": [{"id": "img-1", "status": "success", "url": "/images/a.png"}],
        "createdAt": "2026-10-13T00:00:00.000Z",
        "status": status,
        "resultsDeleted": results_deleted,
    }


def conversation(conversation_id: str, updated_at: str, title: str = "会话", turns: list | None = None) -> dict:
    return {
        "id": conversation_id,
        "title": title,
        "model": "gpt-image-2",
        "createdAt": "2026-10-13T00:00:00.000Z",
        "updatedAt": updated_at,
        "turns": turns if turns is not None else [turn(f"{conversation_id}-turn")],
    }


class ImageConversationServiceTests(unittest.TestCase):
    def make_service(self, path: Path) -> ImageConversationService:
        return ImageConversationService(path)

    def test_save_returns_ack_and_list_returns_summaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            ack = service.save_conversations(OWNER, [conversation("c1", "2026-10-13T01:00:00.000Z")])
            self.assertEqual(ack, {"ok": True, "count": 1})

            items = service.list_conversations(OWNER)["items"]
            self.assertEqual(len(items), 1)
            summary = items[0]
            self.assertEqual(summary["id"], "c1")
            self.assertEqual(summary["title"], "会话")
            self.assertEqual(summary["turnCount"], 1)
            self.assertEqual(summary["stats"], {"queued": 0, "running": 0})
            # 摘要不得携带 turns / owner_id / base64
            self.assertNotIn("turns", summary)
            self.assertNotIn("owner_id", summary)
            self.assertEqual(service.list_conversations(OTHER)["items"], [])

    def test_summary_counts_queued_and_running_ignoring_deleted_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            service.save_conversations(
                OWNER,
                [
                    conversation(
                        "c1",
                        "2026-10-13T01:00:00.000Z",
                        turns=[
                            turn("t-queued", "queued"),
                            turn("t-running", "generating"),
                            turn("t-done", "success"),
                            turn("t-deleted", "generating", results_deleted=True),
                        ],
                    )
                ],
            )
            summary = service.list_conversations(OWNER)["items"][0]
            self.assertEqual(summary["turnCount"], 4)
            self.assertEqual(summary["stats"], {"queued": 1, "running": 1})

    def test_get_conversation_returns_full_payload_scoped_to_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            service.save_conversations(OWNER, [conversation("c1", "2026-10-13T01:00:00.000Z")])

            full = service.get_conversation(OWNER, "c1")
            self.assertIsNotNone(full)
            self.assertNotIn("owner_id", full)
            self.assertEqual(full["turns"][0]["prompt"], "a red fox")
            self.assertEqual(full["turns"][0]["referenceImages"][0]["dataUrl"], "data:image/png;base64,AAAA")
            self.assertEqual(full["turns"][0]["maskImages"][0]["dataUrl"], "data:image/png;base64,BBBB")

            self.assertIsNone(service.get_conversation(OTHER, "c1"))
            self.assertIsNone(service.get_conversation(OWNER, "missing"))

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
            self.assertEqual(service.rename_conversation(OWNER, "c1", "重命名"), {"ok": True})
            items = service.list_conversations(OWNER)["items"]
            titles = {item["id"]: item["title"] for item in items}
            self.assertEqual(titles["c1"], "重命名")
            self.assertEqual(items[0]["id"], "c1")

    def test_delete_and_clear_only_affect_owner(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = self.make_service(Path(tmp) / "image_conversations.json")
            service.save_conversations(OWNER, [conversation("c1", "2026-10-13T01:00:00.000Z")])
            service.save_conversations(OTHER, [conversation("c9", "2026-10-13T01:00:00.000Z")])

            self.assertEqual(service.delete_conversation(OWNER, "c1"), {"ok": True})
            self.assertEqual(service.list_conversations(OWNER)["items"], [])
            self.assertEqual([item["id"] for item in service.list_conversations(OTHER)["items"]], ["c9"])

            service.save_conversations(OWNER, [conversation("c2", "2026-10-13T03:00:00.000Z")])
            self.assertEqual(service.clear_conversations(OWNER), {"ok": True})
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
            full = reloaded.get_conversation(OWNER, "c1")
            self.assertEqual(full["turns"][0]["images"][0]["url"], "/images/a.png")

    def test_each_conversation_is_stored_in_its_own_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image_conversations.json"
            service = self.make_service(path)
            service.save_conversations(
                OWNER,
                [
                    conversation("c1", "2026-10-13T01:00:00.000Z"),
                    conversation("c2", "2026-10-13T02:00:00.000Z"),
                ],
            )

            files = sorted((Path(tmp) / "image_conversations").glob("*.json"))
            self.assertEqual(len(files), 2)

            service.delete_conversation(OWNER, "c1")
            self.assertEqual(len(sorted((Path(tmp) / "image_conversations").glob("*.json"))), 1)

    def test_legacy_single_file_is_migrated_on_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image_conversations.json"
            path.write_text(
                json.dumps(
                    {
                        "conversations": [
                            {"id": "c1", "owner_id": "owner-1", "title": "旧会话", "turns": []},
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            service = self.make_service(path)

            self.assertEqual([item["id"] for item in service.list_conversations(OWNER)["items"]], ["c1"])
            self.assertTrue(path.with_suffix(".json.migrated").exists())
            self.assertEqual(len(sorted((Path(tmp) / "image_conversations").glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
