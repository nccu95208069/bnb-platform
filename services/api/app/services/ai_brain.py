"""AI Brain: channel-agnostic message orchestrator."""

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.base import ChannelType, IncomingMessage, OutgoingMessage
from app.channels.registry import get_adapter
from app.models.conversation import MessageRole
from app.services.conversation import ConversationService
from app.services.llm import BNB_SYSTEM_PROMPT, llm_service
from app.services.rag import RAGService

logger = logging.getLogger(__name__)


class AIBrain:
    """Channel-agnostic AI message handler.

    Orchestrates conversation management, RAG context building,
    and LLM response generation without knowing which channel
    the message came from.
    """

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.conv_service = ConversationService(db)

    async def handle_message(self, incoming: IncomingMessage) -> OutgoingMessage | None:
        """Process an incoming message and optionally produce a response.

        Routes to the appropriate handler based on message_type.

        Returns:
            OutgoingMessage if a response should be sent, None otherwise.
        """
        if incoming.message_type == "text":
            return await self._handle_text(incoming)
        elif incoming.message_type == "image":
            return self._make_reply(
                incoming, "已收到您的圖片，目前僅支援文字訊息。"
            )
        elif incoming.message_type == "sticker":
            return self._make_reply(
                incoming, "收到您的貼圖！請問有什麼可以幫您的嗎？"
            )
        elif incoming.message_type == "follow":
            return await self._handle_follow(incoming)
        elif incoming.message_type == "unfollow":
            logger.info("User unfollowed: %s", incoming.channel_user_id)
            return None
        else:
            logger.info(
                "Unsupported message type from %s: %s",
                incoming.channel_user_id,
                incoming.message_type,
            )
            return None

    async def _handle_text(self, incoming: IncomingMessage) -> OutgoingMessage | None:
        """Handle a text message: store, optionally generate AI reply."""
        user_text = incoming.text or ""
        logger.info(
            "Text message from %s: %s",
            incoming.channel_user_id,
            user_text[:50],
        )

        conversation = await self.conv_service.get_or_create_conversation(
            channel=incoming.channel,
            channel_user_id=incoming.channel_user_id,
            display_name=incoming.display_name,
        )
        await self.conv_service.add_message(conversation.id, MessageRole.USER, user_text)

        if await self.conv_service.is_ai_mode(conversation.id):
            history = await self.conv_service.get_conversation_history(conversation.id)
            try:
                rag_service = RAGService(self.db)
                rag_context = await rag_service.build_context(user_text)
                system_prompt = BNB_SYSTEM_PROMPT
                if rag_context:
                    system_prompt += f"\n\n以下是相關的民宿資料，請參考回答：\n{rag_context}"

                llm_response = await llm_service.generate(
                    messages=history,
                    system_prompt=system_prompt,
                )
                await self.conv_service.add_message(
                    conversation.id,
                    MessageRole.ASSISTANT,
                    llm_response.content,
                    llm_model=llm_response.model,
                    token_usage=llm_response.input_tokens + llm_response.output_tokens,
                )
                return self._make_reply(incoming, llm_response.content)
            except RuntimeError:
                logger.exception("LLM generation failed")
                return self._make_reply(
                    incoming, "抱歉，系統暫時無法回應，請稍後再試或聯繫民宿主人。"
                )
        else:
            logger.info(
                "Conversation %s in HUMAN mode, skipping auto-reply",
                conversation.id,
            )
            return None

    async def _handle_follow(self, incoming: IncomingMessage) -> OutgoingMessage:
        """Handle a new follower: create conversation and send welcome."""
        logger.info("New follower: %s", incoming.channel_user_id)
        await self.conv_service.get_or_create_conversation(
            channel=incoming.channel,
            channel_user_id=incoming.channel_user_id,
            display_name=incoming.display_name,
        )
        return self._make_reply(
            incoming,
            "歡迎！我是民宿智能客服，有任何關於訂房、設施或周邊資訊的問題，都可以問我。",
        )

    async def send_owner_message(
        self,
        conversation_id: uuid.UUID,
        content: str,
    ) -> None:
        """Send a message from the owner to a conversation's channel.

        Looks up the conversation's channel and user ID, then sends
        via the appropriate adapter.
        """
        conversation = await self.conv_service.get_conversation_detail(conversation_id)
        if conversation is None:
            raise ValueError(f"Conversation {conversation_id} not found")

        adapter = get_adapter(conversation.channel)
        await adapter.send_message(
            OutgoingMessage(
                channel=conversation.channel,
                channel_user_id=conversation.channel_user_id,
                text=content,
            )
        )

    @staticmethod
    def _make_reply(incoming: IncomingMessage, text: str) -> OutgoingMessage:
        """Create a reply OutgoingMessage from an IncomingMessage."""
        return OutgoingMessage(
            channel=incoming.channel,
            channel_user_id=incoming.channel_user_id,
            text=text,
            reply_token=incoming.reply_token,
        )
