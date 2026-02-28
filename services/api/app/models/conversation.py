"""Conversation and message models."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.channels.base import ChannelType
from app.models.base import Base, TimestampMixin, UUIDMixin


class ConversationStatus(str, enum.Enum):
    """Status of a conversation."""

    AI = "ai"
    HUMAN = "human"


class MessageRole(str, enum.Enum):
    """Role of a message sender."""

    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    OWNER = "owner"


class Conversation(Base, UUIDMixin, TimestampMixin):
    """A conversation thread with a channel user."""

    __tablename__ = "conversations"

    channel: Mapped[ChannelType] = mapped_column(
        Enum(ChannelType), nullable=False, default=ChannelType.LINE
    )
    channel_user_id: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[ConversationStatus] = mapped_column(
        Enum(ConversationStatus),
        default=ConversationStatus.AI,
        nullable=False,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        order_by="Message.created_at",
        cascade="all, delete-orphan",
    )


class Message(Base, UUIDMixin, TimestampMixin):
    """A single message within a conversation."""

    __tablename__ = "messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[MessageRole] = mapped_column(Enum(MessageRole), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    llm_model: Mapped[str | None] = mapped_column(String(100))
    token_usage: Mapped[int | None] = mapped_column()

    conversation: Mapped[Conversation] = relationship(back_populates="messages")
