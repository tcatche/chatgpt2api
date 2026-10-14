from __future__ import annotations

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


class ImageConversationService:
    """按登录身份持久化图片会话（含多轮、参考图/蒙版与结果引用）。

    历史归属维度是调用者身份（`owner_id`），与号池账号无关；每个身份只能读到自己的会话。
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._items = self._load_locked()

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
                saved += 1
            self._save_locked()
        return {"ok": True, "count": saved}

    def rename_conversation(self, identity: dict[str, object], conversation_id: str, title: str) -> dict[str, Any]:
        owner = _owner_id(identity)
        key = _conversation_key(owner, _clean(conversation_id))
        with self._lock:
            current = self._items.get(key)
            if current is not None:
                current["title"] = _clean(title)
                current["updatedAt"] = _now_iso()
                self._save_locked()
        return {"ok": True}

    def delete_conversation(self, identity: dict[str, object], conversation_id: str) -> dict[str, Any]:
        owner = _owner_id(identity)
        key = _conversation_key(owner, _clean(conversation_id))
        with self._lock:
            if self._items.pop(key, None) is not None:
                self._save_locked()
        return {"ok": True}

    def clear_conversations(self, identity: dict[str, object]) -> dict[str, Any]:
        owner = _owner_id(identity)
        with self._lock:
            owned_keys = [key for key, item in self._items.items() if item.get("owner_id") == owner]
            for key in owned_keys:
                self._items.pop(key, None)
            if owned_keys:
                self._save_locked()
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
            items[_conversation_key(owner, conversation_id)] = {
                **item,
                "id": conversation_id,
                "owner_id": owner,
            }
        return items

    def _save_locked(self) -> None:
        items = sorted(
            self._items.values(),
            key=lambda item: _timestamp(item.get("updatedAt")),
            reverse=True,
        )
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(
            json.dumps({"conversations": items}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        tmp_path.replace(self.path)


image_conversation_service = ImageConversationService(DATA_DIR / "image_conversations.json")
