from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from services.config import DATA_DIR


def _clean(value: object, default: str = "") -> str:
    text = str(value if value is not None else default).strip()
    return text


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _conversation_key(owner_id: str, conversation_id: str) -> str:
    return f"{owner_id}:{conversation_id}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    text = value.strip()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def image_filename_from_url(url: object) -> str:
    """从结果图 URL 中取文件名，用于和图片管理里的图片做关联。"""
    text = str(url or "").strip()
    if not text or text.startswith("data:"):
        return ""
    text = text.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    if not text:
        return ""
    name = text.rsplit("/", 1)[-1]
    return name if "." in name else ""


class ImageConversationService:
    """按登录身份持久化图片会话（含多轮、参考图/蒙版与结果引用）。

    历史归属维度是调用者身份（`owner_id`），与号池账号无关；每个身份只能读到自己的会话。
    每个会话单独存一个文件，更新某个会话时不再重写全部会话。
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._items = self._load_locked()

    @property
    def directory(self) -> Path:
        """会话文件目录，与历史单文件同名（去掉后缀）。"""
        return self.path.with_suffix("")

    def list_conversations(self, identity: dict[str, object]) -> dict[str, Any]:
        owner = _owner_id(identity)
        with self._lock:
            items = [
                self._summary(item)
                for item in self._items.values()
                if item.get("owner_id") == owner
            ]
        items.sort(key=lambda item: _timestamp(item.get("updatedAt")), reverse=True)
        return {"items": items}

    def list_image_refs(self) -> list[dict[str, Any]]:
        """列出所有会话的结果图引用，供图片管理按会话筛选/删除使用（与登录身份无关）。"""
        with self._lock:
            items = list(self._items.values())
        refs: list[dict[str, Any]] = []
        for item in items:
            turns = item.get("turns") if isinstance(item.get("turns"), list) else []
            filenames: list[str] = []
            for turn in turns:
                if not isinstance(turn, dict):
                    continue
                images = turn.get("images")
                if not isinstance(images, list):
                    continue
                for image in images:
                    if not isinstance(image, dict):
                        continue
                    name = image_filename_from_url(image.get("url"))
                    if name:
                        filenames.append(name)
            if not filenames:
                continue
            refs.append({
                "conversation_id": _clean(item.get("id")),
                "title": _clean(item.get("title")),
                "owner_id": _clean(item.get("owner_id")),
                "updated_at": _clean(item.get("updatedAt")),
                "filenames": filenames,
            })
        return refs

    def get_conversation(self, identity: dict[str, object], conversation_id: str) -> dict[str, Any] | None:
        owner = _owner_id(identity)
        key = _conversation_key(owner, _clean(conversation_id))
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            return self._public(item)

    def save_conversations(self, identity: dict[str, object], conversations: list[dict[str, Any]]) -> dict[str, Any]:
        owner = _owner_id(identity)
        saved = 0
        with self._lock:
            for raw in conversations:
                if not isinstance(raw, dict):
                    continue
                conversation_id = _clean(raw.get("id"))
                if not conversation_id:
                    continue
                key = _conversation_key(owner, conversation_id)
                incoming = {**raw, "id": conversation_id, "owner_id": owner}
                incoming["updatedAt"] = (
                    _clean(incoming.get("updatedAt"))
                    or _clean(incoming.get("createdAt"))
                    or _now_iso()
                )
                current = self._items.get(key)
                if current is not None and _timestamp(current.get("updatedAt")) > _timestamp(incoming.get("updatedAt")):
                    continue
                self._items[key] = incoming
                self._write_item_locked(key, incoming)
                saved += 1
        return {"ok": True, "count": saved}

    def rename_conversation(self, identity: dict[str, object], conversation_id: str, title: str) -> dict[str, Any]:
        owner = _owner_id(identity)
        key = _conversation_key(owner, _clean(conversation_id))
        with self._lock:
            current = self._items.get(key)
            if current is not None:
                current["title"] = _clean(title)
                current["updatedAt"] = _now_iso()
                self._write_item_locked(key, current)
        return {"ok": True}

    def delete_conversation(self, identity: dict[str, object], conversation_id: str) -> dict[str, Any]:
        owner = _owner_id(identity)
        key = _conversation_key(owner, _clean(conversation_id))
        with self._lock:
            if self._items.pop(key, None) is not None:
                self._delete_item_file_locked(key)
        return {"ok": True}

    def clear_conversations(self, identity: dict[str, object]) -> dict[str, Any]:
        owner = _owner_id(identity)
        with self._lock:
            owned_keys = [key for key, item in self._items.items() if item.get("owner_id") == owner]
            for key in owned_keys:
                self._items.pop(key, None)
                self._delete_item_file_locked(key)
        return {"ok": True}

    @staticmethod
    def _summary(item: dict[str, Any]) -> dict[str, Any]:
        turns = item.get("turns") if isinstance(item.get("turns"), list) else []
        queued = 0
        running = 0
        for turn in turns:
            if not isinstance(turn, dict) or turn.get("resultsDeleted"):
                continue
            status = _clean(turn.get("status"))
            if status == "queued":
                queued += 1
            elif status == "generating":
                running += 1
        return {
            "id": _clean(item.get("id")),
            "title": _clean(item.get("title")),
            "model": _clean(item.get("model")),
            "createdAt": _clean(item.get("createdAt")),
            "updatedAt": _clean(item.get("updatedAt")),
            "turnCount": len(turns),
            "stats": {"queued": queued, "running": running},
        }

    @staticmethod
    def _public(item: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in item.items() if key != "owner_id"}

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        items = self._migrate_legacy_locked()
        directory = self.directory
        if directory.is_dir():
            for file in directory.glob("*.json"):
                item = self._read_item_file(file)
                if item is not None:
                    items[_conversation_key(item["owner_id"], item["id"])] = item
        return items

    def _migrate_legacy_locked(self) -> dict[str, dict[str, Any]]:
        """把历史单文件拆成每会话一个文件；拆完把原文件改名留存，便于回退。"""
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        raw_items = raw.get("conversations") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            return {}
        items: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            conversation_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not conversation_id or not owner:
                continue
            normalized = {**item, "id": conversation_id, "owner_id": owner}
            key = _conversation_key(owner, conversation_id)
            items[key] = normalized
            self._write_item_locked(key, normalized)
        try:
            self.path.replace(self.path.with_suffix(self.path.suffix + ".migrated"))
        except OSError:
            pass
        return items

    @staticmethod
    def _read_item_file(file: Path) -> dict[str, Any] | None:
        try:
            raw = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(raw, dict):
            return None
        conversation_id = _clean(raw.get("id"))
        owner = _clean(raw.get("owner_id"))
        if not conversation_id or not owner:
            return None
        return {**raw, "id": conversation_id, "owner_id": owner}

    def _item_file(self, key: str) -> Path:
        return self.directory / f"{hashlib.sha1(key.encode('utf-8')).hexdigest()}.json"

    def _write_item_locked(self, key: str, item: dict[str, Any]) -> None:
        directory = self.directory
        directory.mkdir(parents=True, exist_ok=True)
        target = self._item_file(key)
        tmp_path = target.with_suffix(target.suffix + ".tmp")
        tmp_path.write_text(
            json.dumps(item, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        tmp_path.replace(target)

    def _delete_item_file_locked(self, key: str) -> None:
        try:
            self._item_file(key).unlink()
        except OSError:
            pass


image_conversation_service = ImageConversationService(DATA_DIR / "image_conversations.json")
