"""Conversation management service with human takeover support."""

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.channels.base import ChannelType
from app.models.conversation import Conversation, ConversationStatus, Message, MessageRole

logger = logging.getLogger(__name__)


class ConversationService:
    """Service for managing conversations and messages."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_or_create_conversation(
        self,
        channel: ChannelType,
        channel_user_id: str,
        display_name: str | None = None,
    ) -> Conversation:
        """Get an active conversation for a channel user, or create a new one."""
        stmt = select(Conversation).where(
            Conversation.channel == channel,
            Conversation.channel_user_id == channel_user_id,
            Conversation.is_active == True,  # noqa: E712
        )
        result = await self.db.execute(stmt)
        conversation = result.scalar_one_or_none()

        if conversation is None:
            conversation = Conversation(
                channel=channel,
                channel_user_id=channel_user_id,
                display_name=display_name,
                status=ConversationStatus.AI,
            )
            self.db.add(conversation)
            await self.db.flush()
            logger.info(
                "Created new conversation %s for %s user %s",
                conversation.id,
                channel.value,
                channel_user_id,
            )

        return conversation

    async def add_message(
        self,
        conversation_id: uuid.UUID,
        role: MessageRole,
        content: str,
        llm_model: str | None = None,
        token_usage: int | None = None,
    ) -> Message:
        """Add a message to a conversation."""
        message = Message(
            conversation_id=conversation_id,
            role=role,
            content=content,
            llm_model=llm_model,
            token_usage=token_usage,
        )
        self.db.add(message)
        await self.db.flush()
        return message

    async def get_conversation_history(
        self,
        conversation_id: uuid.UUID,
        limit: int = 6,
    ) -> list[dict[str, str]]:
        """Get recent message history formatted for LLM context.

        Returns messages in the format [{"role": "user", "content": "..."}].
        """
        stmt = (
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(limit)
        )
        result = await self.db.execute(stmt)
        messages = list(reversed(result.scalars().all()))

        return [
            {
                "role": (
                    "user" if msg.role in (MessageRole.USER, MessageRole.OWNER) else "assistant"
                ),
                "content": msg.content,
            }
            for msg in messages
            if msg.role in (MessageRole.USER, MessageRole.ASSISTANT, MessageRole.OWNER)
        ]

    async def is_ai_mode(self, conversation_id: uuid.UUID) -> bool:
        """Check if a conversation is in AI auto-reply mode."""
        stmt = select(Conversation.status).where(Conversation.id == conversation_id)
        result = await self.db.execute(stmt)
        status = result.scalar_one_or_none()
        return status == ConversationStatus.AI

    async def takeover(self, conversation_id: uuid.UUID) -> Conversation:
        """Switch a conversation to human (owner) mode.

        Raises:
            ValueError: If conversation not found.
        """
        conversation = await self._get_conversation(conversation_id)
        conversation.status = ConversationStatus.HUMAN
        await self.db.flush()
        logger.info("Conversation %s switched to HUMAN mode", conversation_id)
        return conversation

    async def release(self, conversation_id: uuid.UUID) -> Conversation:
        """Switch a conversation back to AI mode.

        Raises:
            ValueError: If conversation not found.
        """
        conversation = await self._get_conversation(conversation_id)
        conversation.status = ConversationStatus.AI
        await self.db.flush()
        logger.info("Conversation %s switched to AI mode", conversation_id)
        return conversation

    async def list_conversations(
        self,
        status: ConversationStatus | None = None,
        active_only: bool = True,
    ) -> list[Conversation]:
        """List conversations, optionally filtered by status."""
        stmt = select(Conversation).order_by(Conversation.last_message_at.desc())

        if active_only:
            stmt = stmt.where(Conversation.is_active == True)  # noqa: E712
        if status is not None:
            stmt = stmt.where(Conversation.status == status)

        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def get_conversation_detail(self, conversation_id: uuid.UUID) -> Conversation | None:
        """Get a conversation with its messages."""
        stmt = (
            select(Conversation)
            .options(selectinload(Conversation.messages))
            .where(Conversation.id == conversation_id)
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def _get_conversation(self, conversation_id: uuid.UUID) -> Conversation:
        """Get a conversation by ID or raise ValueError."""
        stmt = select(Conversation).where(Conversation.id == conversation_id)
        result = await self.db.execute(stmt)
        conversation = result.scalar_one_or_none()

        if conversation is None:
            raise ValueError(f"Conversation {conversation_id} not found")

        return conversation
