from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.support import require_identity
from services.image_conversation_service import image_conversation_service


class SaveImageConversationsRequest(BaseModel):
    conversations: list[dict[str, Any]] = Field(default_factory=list)


class RenameImageConversationRequest(BaseModel):
    title: str = ""


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-conversations")
    async def list_image_conversations(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_conversation_service.list_conversations, identity)

    @router.get("/api/image-conversations/{conversation_id}")
    async def get_image_conversation(conversation_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        conversation = await run_in_threadpool(
            image_conversation_service.get_conversation,
            identity,
            conversation_id,
        )
        if conversation is None:
            raise HTTPException(status_code=404, detail={"error": "conversation not found"})
        return {"conversation": conversation}

    @router.post("/api/image-conversations")
    async def save_image_conversations(
        body: SaveImageConversationsRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(
            image_conversation_service.save_conversations,
            identity,
            body.conversations,
        )

    @router.post("/api/image-conversations/{conversation_id}/rename")
    async def rename_image_conversation(
        conversation_id: str,
        body: RenameImageConversationRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(
            image_conversation_service.rename_conversation,
            identity,
            conversation_id,
            body.title,
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
