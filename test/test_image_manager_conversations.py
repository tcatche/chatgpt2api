from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services import image_service
from services.image_conversation_service import ImageConversationService, image_filename_from_url

OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}


def conversation(conversation_id: str, title: str, updated_at: str, filenames: list[str]) -> dict:
    return {
        "id": conversation_id,
        "title": title,
        "model": "gpt-image-2",
        "createdAt": "2026-10-13T00:00:00.000Z",
        "updatedAt": updated_at,
        "turns": [
            {
                "id": f"{conversation_id}-turn",
                "images": [
                    {
                        "id": f"{conversation_id}-img-{index}",
                        "status": "success",
                        "url": f"http://app.test/images/2026/10/13/{filename}",
                    }
                    for index, filename in enumerate(filenames)
                ],
            }
        ],
    }


class FakeStorage:
    def __init__(self, items: list[dict[str, object]]) -> None:
        self.items = items
        self.deleted: list[str] = []

    def list_items(self, _base_url: str, start_date: str = "", end_date: str = "") -> list[dict[str, object]]:
        items = self.items
        if start_date:
            items = [item for item in items if str(item.get("date") or "") >= start_date]
        if end_date:
            items = [item for item in items if str(item.get("date") or "") <= end_date]
        return [dict(item) for item in items]

    def delete(self, rel: str) -> bool:
        self.deleted.append(rel)
        return True


def storage_item(rel: str, day: str) -> dict[str, object]:
    return {
        "rel": rel,
        "path": rel,
        "name": Path(rel).name,
        "date": day,
        "size": 10,
        "created_at": f"{day} 10:00:00",
        "storage": "local",
        "local": True,
        "webdav": False,
    }


class ImageFilenameTests(unittest.TestCase):
    def test_image_filename_from_url_normalizes_url(self) -> None:
        self.assertEqual(
            image_filename_from_url("http://app.test/images/2026/10/13/1728000000_abc.png"),
            "1728000000_abc.png",
        )
        self.assertEqual(
            image_filename_from_url("https://dav.example.test/chatgpt2api/images/2026/10/13/a.png?token=1#x"),
            "a.png",
        )
        self.assertEqual(image_filename_from_url("/images/2026/10/13/a.png"), "a.png")
        self.assertEqual(image_filename_from_url("data:image/png;base64,AAAA"), "")
        self.assertEqual(image_filename_from_url(""), "")


class ImageConversationRefTests(unittest.TestCase):
    def test_list_image_refs_collects_filenames_per_conversation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            service = ImageConversationService(Path(tmp) / "image_conversations.json")
            service.save_conversations(
                OWNER,
                [
                    conversation("c1", "会话一", "2026-10-13T01:00:00.000Z", ["a.png", "b.png"]),
                    conversation("c2", "会话二", "2026-10-12T01:00:00.000Z", []),
                ],
            )

            refs = service.list_image_refs()

        self.assertEqual([ref["conversation_id"] for ref in refs], ["c1"])
        self.assertEqual(refs[0]["title"], "会话一")
        self.assertEqual(refs[0]["filenames"], ["a.png", "b.png"])


    def test_list_image_refs_handles_relative_urls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            service = ImageConversationService(Path(tmp) / "image_conversations.json")
            service.save_conversations(
                OWNER,
                [
                    {
                        **conversation("c1", "会话一", "2026-10-13T01:00:00.000Z", []),
                        "turns": [
                            {
                                "id": "c1-turn",
                                "images": [
                                    {"id": "img-1", "status": "success", "url": "/images/2026/10/13/a.png"},
                                ],
                            }
                        ],
                    }
                ],
            )

            refs = service.list_image_refs()

        self.assertEqual(refs[0]["filenames"], ["a.png"])


class ImageListConversationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name)
        self.images_dir = self.data_dir / "images"
        self.images_dir.mkdir(parents=True, exist_ok=True)

        self.config_patcher = mock.patch("services.image_service.config")
        self.mock_config = self.config_patcher.start()
        self.addCleanup(self.config_patcher.stop)
        self.mock_config.images_dir = self.images_dir
        self.mock_config.image_thumbnails_dir = self.data_dir / "thumbnails"
        self.mock_config.base_url = "http://app.test"
        self.mock_config.cleanup_old_images.return_value = 0

        self.cleanup_patcher = mock.patch("services.image_service.cleanup_image_thumbnails", return_value=0)
        self.cleanup_patcher.start()
        self.addCleanup(self.cleanup_patcher.stop)
        self.tags_patcher = mock.patch("services.image_service.load_tags", return_value={})
        self.tags_patcher.start()
        self.addCleanup(self.tags_patcher.stop)
        self.remove_tags_patcher = mock.patch("services.image_service.remove_tags")
        self.remove_tags_patcher.start()
        self.addCleanup(self.remove_tags_patcher.stop)

    def use(self, refs: list[dict[str, object]], items: list[dict[str, object]]) -> FakeStorage:
        storage = FakeStorage(items)
        conversations = mock.Mock()
        conversations.list_image_refs.return_value = refs
        storage_patcher = mock.patch("services.image_service.image_storage_service", storage)
        storage_patcher.start()
        self.addCleanup(storage_patcher.stop)
        conversation_patcher = mock.patch("services.image_service.image_conversation_service", conversations)
        conversation_patcher.start()
        self.addCleanup(conversation_patcher.stop)
        return storage

    def test_list_images_attaches_conversation_and_builds_dropdown(self) -> None:
        refs = [
            {"conversation_id": "c1", "title": "会话一", "updated_at": "2026-10-13T01:00:00.000Z", "filenames": ["a.png"]},
            {"conversation_id": "c2", "title": "会话二", "updated_at": "2026-10-12T01:00:00.000Z", "filenames": ["b.png"]},
        ]
        self.use(refs, [
            storage_item("2026/10/13/a.png", "2026-10-13"),
            storage_item("2026/10/13/b.png", "2026-10-13"),
            storage_item("2026/10/13/c.png", "2026-10-13"),
        ])

        result = image_service.list_images("http://app.test")

        by_name = {item["name"]: item for item in result["items"]}
        self.assertEqual(by_name["a.png"]["conversation_id"], "c1")
        self.assertEqual(by_name["a.png"]["conversation_title"], "会话一")
        self.assertEqual(by_name["b.png"]["conversation_id"], "c2")
        self.assertEqual(by_name["c.png"]["conversation_id"], "")
        self.assertEqual([item["id"] for item in result["conversations"]], ["c1", "c2"])
        self.assertEqual([item["image_count"] for item in result["conversations"]], [1, 1])
        self.assertEqual(result["unlinked_count"], 1)
        self.assertEqual(result["unlinked_total"], 1)

    def test_conversation_filter_keeps_dropdown_membership(self) -> None:
        refs = [
            {"conversation_id": "c1", "title": "会话一", "updated_at": "2026-10-13T01:00:00.000Z", "filenames": ["a.png"]},
            {"conversation_id": "c2", "title": "会话二", "updated_at": "2026-10-12T01:00:00.000Z", "filenames": ["b.png"]},
        ]
        self.use(refs, [
            storage_item("2026/10/13/a.png", "2026-10-13"),
            storage_item("2026/10/13/b.png", "2026-10-13"),
        ])

        filtered = image_service.list_images("http://app.test", conversation_id="c1")

        self.assertEqual([item["name"] for item in filtered["items"]], ["a.png"])
        self.assertEqual(sorted(item["id"] for item in filtered["conversations"]), ["c1", "c2"])

        unlinked = image_service.list_images("http://app.test", conversation_id=image_service.UNLINKED_CONVERSATION_ID)
        self.assertEqual(unlinked["items"], [])

    def test_dropdown_membership_ignores_date_filter(self) -> None:
        refs = [
            {"conversation_id": "c1", "title": "会话一", "updated_at": "2026-10-13T01:00:00.000Z", "filenames": ["a.png"]},
            {"conversation_id": "c2", "title": "会话二", "updated_at": "2026-01-01T01:00:00.000Z", "filenames": ["b.png"]},
        ]
        self.use(refs, [
            storage_item("2026/10/13/a.png", "2026-10-13"),
            storage_item("2026/01/01/b.png", "2026-01-01"),
        ])

        result = image_service.list_images("http://app.test", start_date="2026-10-01")

        self.assertEqual([item["name"] for item in result["items"]], ["a.png"])
        counts = {item["id"]: item["image_count"] for item in result["conversations"]}
        totals = {item["id"]: item["image_total"] for item in result["conversations"]}
        self.assertEqual(counts, {"c1": 1, "c2": 0})
        self.assertEqual(totals, {"c1": 1, "c2": 1})

    def test_same_filename_prefers_most_recently_updated_conversation(self) -> None:
        refs = [
            {"conversation_id": "old", "title": "旧会话", "updated_at": "2026-01-01T00:00:00.000Z", "filenames": ["a.png"]},
            {"conversation_id": "new", "title": "新会话", "updated_at": "2026-10-13T00:00:00.000Z", "filenames": ["a.png"]},
        ]
        self.use(refs, [storage_item("2026/10/13/a.png", "2026-10-13")])

        result = image_service.list_images("http://app.test")

        self.assertEqual(result["items"][0]["conversation_id"], "new")

    def test_delete_images_by_conversation(self) -> None:
        refs = [
            {"conversation_id": "c1", "title": "会话一", "updated_at": "2026-10-13T01:00:00.000Z", "filenames": ["a.png"]},
        ]
        storage = self.use(refs, [
            storage_item("2026/10/13/a.png", "2026-10-13"),
            storage_item("2026/10/13/b.png", "2026-10-13"),
        ])

        removed = image_service.delete_images(conversation_id="c1")

        self.assertEqual(removed, {"removed": 1})
        self.assertEqual(storage.deleted, ["2026/10/13/a.png"])

    def test_delete_images_by_unlinked(self) -> None:
        refs = [
            {"conversation_id": "c1", "title": "会话一", "updated_at": "2026-10-13T01:00:00.000Z", "filenames": ["a.png"]},
        ]
        storage = self.use(refs, [
            storage_item("2026/10/13/a.png", "2026-10-13"),
            storage_item("2026/10/13/b.png", "2026-10-13"),
        ])

        removed = image_service.delete_images(conversation_id=image_service.UNLINKED_CONVERSATION_ID)

        self.assertEqual(removed, {"removed": 1})
        self.assertEqual(storage.deleted, ["2026/10/13/b.png"])


if __name__ == "__main__":
    unittest.main()
