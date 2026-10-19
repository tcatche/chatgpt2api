from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.image_conversation_service import ImageConversationService
from services.image_storage_service import StoredImage


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

    def test_migrate_references_moves_base64_to_storage(self):
        image_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        )
        data_url = "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")
        encoded = base64.b64encode(image_bytes).decode("ascii")

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image_conversations.json"
            service = self.make_service(path)
            raw = conversation("c1", "2026-10-13T01:00:00.000Z", turns=[turn("t1")])
            raw["turns"][0]["referenceImages"] = [
                {"name": "ref.png", "type": "image/png", "dataUrl": data_url}
            ]
            raw["turns"][0]["maskImages"] = [
                {"name": "mask.png", "type": "image/png", "dataUrl": data_url}
            ]
            raw["turns"][0]["images"] = [{"id": "img-1", "status": "success", "b64_json": encoded}]
            service.save_conversations(OWNER, [raw])

            calls: list[tuple[int, str, str]] = []

            def fake_save_input(payload, base_url=None, *, extension=".png", content_type="image/png"):
                calls.append((len(payload), extension, content_type))
                index = len(calls)
                return StoredImage(
                    rel=f"inputs/{index}.png",
                    url=f"https://cdn.test/inputs/{index}.png",
                    storage="local",
                    size=len(payload),
                )

            with mock.patch(
                "services.image_storage_service.image_storage_service.save_input",
                side_effect=fake_save_input,
            ):
                result = service.migrate_references("http://app.test")

            self.assertEqual(result, {"converted": 3, "failed": 0})
            self.assertEqual(len(calls), 3)

            migrated = service.get_conversation(OWNER, "c1")
            migrated_turn = migrated["turns"][0]
            self.assertNotIn("dataUrl", migrated_turn["referenceImages"][0])
            self.assertTrue(migrated_turn["referenceImages"][0]["url"].startswith("https://cdn.test/inputs/"))
            self.assertNotIn("dataUrl", migrated_turn["maskImages"][0])
            self.assertNotIn("b64_json", migrated_turn["images"][0])
            self.assertTrue(migrated_turn["images"][0]["url"].startswith("https://cdn.test/inputs/"))

            reloaded = self.make_service(path)
            again = reloaded.get_conversation(OWNER, "c1")
            self.assertEqual(again["turns"][0]["referenceImages"][0]["url"], migrated_turn["referenceImages"][0]["url"])
            # 迁移是幂等的：已经带 url 的条目不会再处理
            self.assertEqual(reloaded.migrate_references("http://app.test"), {"converted": 0, "failed": 0})


if __name__ == "__main__":
    unittest.main()
