"""Pydantic schemas for conversation API."""

import uuid
from datetime import datetime

from pydantic import BaseModel

from app.channels.base import ChannelType
from app.models.conversation import ConversationStatus, MessageRole


class MessageOut(BaseModel):
    """Schema for a message response."""

    id: uuid.UUID
    role: MessageRole
    content: str
    llm_model: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationOut(BaseModel):
    """Schema for a conversation response."""

    id: uuid.UUID
    channel: ChannelType
    channel_user_id: str
    display_name: str | None = None
    status: ConversationStatus
    is_active: bool
    last_message_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationDetailOut(ConversationOut):
    """Schema for a conversation with messages."""

    messages: list[MessageOut] = []


class SendMessageRequest(BaseModel):
    """Request for the owner to send a message to a conversation."""

    content: str


class TakeoverRequest(BaseModel):
    """Request to switch conversation to human mode."""

    pass


class HandbackRequest(BaseModel):
    """Request to switch conversation back to AI mode."""

    pass
