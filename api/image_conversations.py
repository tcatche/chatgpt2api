from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header
from fastapi.concurrency import run_in_threadpool

from api.support import require_identity
from services.image_conversation_service import image_conversation_service


def _conversations_from_body(body: Any) -> list[dict[str, Any]]:
    if isinstance(body, list):
        return [item for item in body if isinstance(item, dict)]
    if isinstance(body, dict):
        conversations = body.get("conversations")
        if isinstance(conversations, list):
            return [item for item in conversations if isinstance(item, dict)]
        if body.get("id"):
            return [body]
    return []


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-conversations")
    async def list_image_conversations(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_conversation_service.list_conversations, identity)

    @router.post("/api/image-conversations")
    async def save_image_conversations(body: Any, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        conversations = _conversations_from_body(body)
        return await run_in_threadpool(image_conversation_service.save_conversations, identity, conversations)

    @router.post("/api/image-conversations/{conversation_id}/rename")
    async def rename_image_conversation(
        conversation_id: str,
        body: Any,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        title = ""
        if isinstance(body, dict):
            title = str(body.get("title") or "")
        return await run_in_threadpool(
            image_conversation_service.rename_conversation,
            identity,
            conversation_id,
            title,
        )

    @router.delete("/api/image-conversations/{conversation_id}")
    async def delete_image_conversation(conversation_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return await run_in_threadpool(
            image_conversation_service.delete_conversation,
            identity,
            conversation_id,
        )

    @router.delete("/api/image-conversations")
    async def clear_image_conversations(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_conversation_service.clear_conversations, identity)

    return router
