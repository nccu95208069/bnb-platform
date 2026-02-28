"""Conversation management and human takeover API endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.conversation import ConversationStatus, MessageRole
from app.schemas.conversation import (
    ConversationDetailOut,
    ConversationOut,
    MessageOut,
    SendMessageRequest,
)
from app.services.ai_brain import AIBrain
from app.services.conversation import ConversationService

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("", response_model=list[ConversationOut])
async def list_conversations(
    status: ConversationStatus | None = Query(None),
    db: AsyncSession = Depends(get_db),
) -> list[ConversationOut]:
    """List all conversations, optionally filtered by status."""
    service = ConversationService(db)
    conversations = await service.list_conversations(status=status)
    return [ConversationOut.model_validate(c) for c in conversations]


@router.get("/{conversation_id}", response_model=ConversationDetailOut)
async def get_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ConversationDetailOut:
    """Get a conversation with its message history."""
    service = ConversationService(db)
    conversation = await service.get_conversation_detail(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationDetailOut.model_validate(conversation)


@router.post("/{conversation_id}/takeover", response_model=ConversationOut)
async def takeover_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ConversationOut:
    """Switch a conversation to human (owner) mode.

    When in human mode, the LLM will not auto-reply to messages.
    The owner handles responses directly.
    """
    service = ConversationService(db)
    try:
        conversation = await service.takeover(conversation_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationOut.model_validate(conversation)


@router.post("/{conversation_id}/release", response_model=ConversationOut)
async def release_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> ConversationOut:
    """Switch a conversation back to AI auto-reply mode."""
    service = ConversationService(db)
    try:
        conversation = await service.release(conversation_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationOut.model_validate(conversation)


@router.post("/{conversation_id}/messages", response_model=MessageOut)
async def send_owner_message(
    conversation_id: uuid.UUID,
    body: SendMessageRequest,
    db: AsyncSession = Depends(get_db),
) -> MessageOut:
    """Send a message as the owner (human takeover mode).

    The message is stored in the database and pushed to the user
    via the appropriate channel adapter.
    """
    service = ConversationService(db)

    conversation = await service.get_conversation_detail(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if conversation.status != ConversationStatus.HUMAN:
        raise HTTPException(
            status_code=400,
            detail="Conversation must be in HUMAN mode to send owner messages. "
            "Use the takeover endpoint first.",
        )

    message = await service.add_message(
        conversation_id,
        MessageRole.OWNER,
        body.content,
    )

    brain = AIBrain(db)
    await brain.send_owner_message(conversation_id, body.content)

    return MessageOut.model_validate(message)
