from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlsplit

from services.config import DATA_DIR, config

TAGS_FILE = DATA_DIR / "image_tags.json"
FAVORITE_TAG = "收藏"


def _ensure_file() -> None:
    TAGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not TAGS_FILE.exists():
        TAGS_FILE.write_text("{}", encoding="utf-8")


def load_tags() -> dict[str, list[str]]:
    _ensure_file()
    try:
        data = json.loads(TAGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def save_tags(data: dict[str, list[str]]) -> None:
    _ensure_file()
    TAGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def get_tags(image_rel: str) -> list[str]:
    return load_tags().get(image_rel, [])


def set_tags(image_rel: str, tags: list[str]) -> list[str]:
    data = load_tags()
    cleaned = list(dict.fromkeys(t.strip() for t in tags if t.strip()))
    if cleaned:
        data[image_rel] = cleaned
    else:
        data.pop(image_rel, None)
    save_tags(data)
    return cleaned


def remove_tags(image_rel: str) -> None:
    data = load_tags()
    if data.pop(image_rel, None) is not None:
        save_tags(data)


def delete_tag(tag: str) -> int:
    """从所有图片中删除指定标签，返回受影响的图片数。"""
    data = load_tags()
    count = 0
    for rel in list(data):
        if tag in data[rel]:
            data[rel] = [t for t in data[rel] if t != tag]
            if not data[rel]:
                del data[rel]
            count += 1
    if count > 0:
        save_tags(data)
    return count


def get_all_tags() -> list[str]:
    data = load_tags()
    seen: set[str] = set()
    result: list[str] = []
    for tags in data.values():
        for t in tags:
            if t not in seen:
                seen.add(t)
                result.append(t)
    return result


def get_tags_many(rels: list[str]) -> dict[str, list[str]]:
    """批量读取多张图片的标签，只返回有标签的条目。"""
    data = load_tags()
    return {rel: data[rel] for rel in rels if rel in data}


def rel_from_public_url(value: str) -> str:
    """把图片 URL 还原成图片存储里的相对路径（兼容 WebDAV 公网地址与同源地址）。"""
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.split("?", 1)[0].split("#", 1)[0]
    path = urlsplit(text).path
    if not path:
        return ""
    public_base = str(config.get_image_storage_settings().get("public_base_url") or "").rstrip("/")
    if public_base and text.startswith(public_base + "/"):
        return text[len(public_base) + 1:].lstrip("/")
    if public_base:
        base_path = urlsplit(public_base).path.rstrip("/")
        if base_path and path.startswith(base_path + "/"):
            return path[len(base_path) + 1:].lstrip("/")
    marker = "/images/"
    index = path.find(marker)
    if index >= 0:
        return path[index + len(marker):].lstrip("/")
    if path.startswith("images/"):
        return path[len("images/"):]
    return ""
