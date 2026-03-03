"""AI Brain: channel-agnostic message orchestrator."""

import logging
import re
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.base import IncomingMessage, OutgoingMessage
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
            return self._make_reply(incoming, "已收到您的圖片，目前僅支援文字訊息。")
        elif incoming.message_type == "sticker":
            return self._make_reply(incoming, "收到您的貼圖！請問有什麼可以幫您的嗎？")
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
                # Step 1: Reformulate follow-up into standalone question
                standalone_query = await self._reformulate_query(history, user_text)
                logger.info("Reformulated query: %s", standalone_query[:80])

                # Step 2: RAG search with standalone query
                rag_service = RAGService(self.db)
                rag_context = await rag_service.build_context(standalone_query)

                # Step 3: Build lightweight history summary (no LLM, free)
                is_new = await self.conv_service.is_new_session(conversation.id)
                summary = self._build_history_summary(history, is_new)

                # Step 4: Fresh single-turn call (no conversation history)
                system_prompt = BNB_SYSTEM_PROMPT
                if summary:
                    system_prompt += f"\n\n[對話摘要] {summary}"

                user_content = ""
                if rag_context:
                    user_content += f"[參考資料]\n{rag_context}\n\n"
                user_content += f"[客人的問題]\n{standalone_query}"

                llm_response = await llm_service.generate(
                    messages=[{"role": "user", "content": user_content}],
                    system_prompt=system_prompt,
                )

                # Strip greeting if not a new session
                if not is_new:
                    llm_response.content = self._strip_greeting(llm_response.content)

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

    async def _reformulate_query(
        self,
        history: list[dict[str, str]],
        current_question: str,
    ) -> str:
        """Reformulate a follow-up question into a standalone question.

        Uses LLM to resolve pronouns and references from conversation history.
        If the question is already standalone, returns it as-is.
        """
        # No history → already standalone
        if len(history) <= 1:
            return current_question

        # Build condensed history for reformulation (last 2 exchanges max)
        recent = history[-5:-1]  # exclude the current message (last in history)
        if not recent:
            return current_question

        history_lines = []
        for msg in recent:
            role = "客人" if msg["role"] == "user" else "客服"
            history_lines.append(f"{role}：{msg['content'][:100]}")
        history_text = "\n".join(history_lines)

        try:
            response = await llm_service.generate(
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"對話歷史：\n{history_text}\n\n"
                            f"客人最新說的話：{current_question}\n\n"
                            f"請把上面「客人最新說的話」改寫成一個獨立完整的問題，"
                            f"讓沒看過對話歷史的人也能理解。\n"
                            f"規則：只輸出改寫後的問題，不加任何解釋或前綴。"
                            f"如果已經是獨立問題，直接輸出原句。"
                        ),
                    }
                ],
                system_prompt="你是問題改寫助手。只輸出一句改寫後的問題。",
            )
            reformulated = response.content.strip()
            for char in "「」''":
                reformulated = reformulated.removeprefix(char).removesuffix(char)
            return reformulated if reformulated else current_question
        except Exception:
            logger.warning("Query reformulation failed, using original question")
            return current_question

    @staticmethod
    def _build_history_summary(history: list[dict[str, str]], is_new_session: bool) -> str:
        """Build a one-line summary of recent conversation topics.

        Extracts user questions from history (excluding the current one)
        to give the LLM awareness of prior topics without full history.
        """
        if is_new_session:
            return "新對話（可以用招呼語開頭）"
        user_questions = [msg["content"][:30] for msg in history[:-1] if msg["role"] == "user"]
        if not user_questions:
            return "新對話（可以用招呼語開頭）"
        recent = user_questions[-3:]
        return "客人之前問過：" + "、".join(recent)

    @staticmethod
    def _strip_greeting(text: str) -> str:
        """Remove greeting prefixes from LLM responses.

        Strips common Chinese/English greetings that appear at the start
        of responses, along with trailing punctuation and whitespace.
        """
        pattern = r"^(您好|你好|哈囉|嗨|Hello|Hi)[！!~～。，,\s]*"
        result = re.sub(pattern, "", text, count=1, flags=re.IGNORECASE).lstrip()
        return result if result else text

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
