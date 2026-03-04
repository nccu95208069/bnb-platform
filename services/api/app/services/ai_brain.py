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

                # Step 1.5: Handle non-question (acknowledgment/emotion)
                if standalone_query.startswith("__ACK__|"):
                    return await self._handle_ack(incoming, conversation, history)

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

    _NON_QUESTION_PATTERN = re.compile(
        r"^("
        r"好的?[，,。！!～~]?|"
        r"嗯+[，,。！!～~]?|"
        r"了解[了]?[，,。！!～~]?|"
        r"OK[，,。！!～~]?|"
        r"謝謝[你您]?[！!～~。]?|"
        r"感謝[！!～~。]?|"
        r"掰掰[！!～~。]?|"
        r"太好了[！!～~。]?|"
        r"真不錯[！!～~。]?|"
        r"蛤[～~]?|"
        r"喔+[，,。！!～~]?"
        r")$",
        re.IGNORECASE,
    )

    @staticmethod
    def _is_non_question(text: str) -> bool:
        """Detect if the message is a polite acknowledgment, not a real question."""
        stripped = text.strip().rstrip("。！!～~，, ")
        # Short messages that are purely emotional/polite
        if len(stripped) <= 15 and AIBrain._NON_QUESTION_PATTERN.match(stripped):
            return True
        # Question markers → definitely a question, even if it has "謝謝"
        q_markers = {"？", "?", "請問", "嗎", "什麼", "怎麼", "哪", "多少", "幾點"}
        if any(m in text for m in q_markers):
            return False
        # Patterns like "好的，謝謝你！" "蛤～太可惜了" "喔喔，太好了"
        # Also catches longer acks like "喔，好，我等等打電話問問看，謝謝你喔！"
        non_q_keywords = [
            "謝謝", "感謝", "了解", "掰掰", "太可惜", "真不錯", "太好了",
            "好的", "沒問題", "知道了", "收到", "OK", "我懂了", "我知道了",
            "我晚點", "等等再", "我再", "好，我",
        ]
        has_keyword = any(k in stripped for k in non_q_keywords)
        return len(stripped) <= 40 and has_keyword

    async def _reformulate_query(
        self,
        history: list[dict[str, str]],
        current_question: str,
    ) -> str:
        """Reformulate a follow-up question into a standalone question.

        Uses LLM to resolve pronouns and references from conversation history.
        If the message is a non-question (acknowledgment/emotion), returns
        a special marker so the main handler can respond appropriately.
        """
        # No history → already standalone
        if len(history) <= 1:
            return current_question

        # Detect non-question messages (polite acks, emotional responses)
        if self._is_non_question(current_question):
            return f"__ACK__|{current_question}"

        # Build recent history for reformulation (last 2 exchanges max)
        # Use full assistant text so the reformulator understands the context
        recent = history[-5:-1]  # exclude the current message (last in history)
        if not recent:
            return current_question

        history_lines = []
        for msg in recent:
            role = "客人" if msg["role"] == "user" else "客服"
            # Keep last assistant message full, truncate earlier ones
            if msg == recent[-1] or msg["role"] == "user":
                history_lines.append(f"{role}：{msg['content']}")
            else:
                history_lines.append(f"{role}：{msg['content'][:150]}")
        history_text = "\n".join(history_lines)

        try:
            response = await llm_service.generate(
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"對話歷史：\n{history_text}\n\n"
                            f"客人最新說的話：{current_question}\n\n"
                            f"任務：判斷客人最新說的話是「提問」還是「非提問」。\n"
                            f"- 非提問：不需要客服提供新資訊的訊息，包括：\n"
                            f"  - 道謝：「好的謝謝」「謝謝你的資訊」\n"
                            f"  - 禮貌收尾：「好，我等等打電話問問看」"
                            f"「好的，我會上去看看的」「我晚點再聯絡」\n"
                            f"  - 情緒表達：「蛤～太可惜了」「喔喔太好了」\n"
                            f"  - 確認收到：「了解」「嗯嗯好」「OK」\n"
                            f"- 提問：需要客服回答新問題或提供新資訊的內容\n\n"
                            f"如果是「非提問」，輸出：__ACK__|原句\n"
                            f"如果是「提問」，把它改寫成一個獨立完整的問題，"
                            f"讓沒看過對話歷史的人也能理解。\n"
                            f"規則：只輸出結果，不加任何解釋或前綴。"
                        ),
                    }
                ],
                system_prompt="你是問題改寫助手。只輸出一句結果。",
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
        """Build a summary with topic anchor + recent questions.

        Includes the first user question as a topic anchor so the LLM
        doesn't lose track of the original conversation theme in later turns.
        """
        if is_new_session:
            return "新對話（可以用招呼語開頭）"
        user_questions = [msg["content"][:30] for msg in history[:-1] if msg["role"] == "user"]
        if not user_questions:
            return "新對話（可以用招呼語開頭）"

        # Topic anchor: first user question defines the conversation theme
        topic = f"本次對話主題：{user_questions[0]}"
        # Recent questions for continuity
        recent = user_questions[-3:]
        recent_str = "最近問過：" + "、".join(recent)
        return f"{topic}｜{recent_str}"

    @staticmethod
    def _strip_greeting(text: str) -> str:
        """Remove greeting prefixes from LLM responses.

        Strips common Chinese/English greetings that appear at the start
        of responses, along with trailing punctuation and whitespace.
        """
        pattern = r"^(您好|你好|哈囉|嗨|Hello|Hi)[！!~～。，,\s]*"
        result = re.sub(pattern, "", text, count=1, flags=re.IGNORECASE).lstrip()
        return result if result else text

    async def _handle_ack(
        self,
        incoming: IncomingMessage,
        conversation: object,
        history: list[dict[str, str]],
    ) -> OutgoingMessage:
        """Handle non-question messages (acknowledgments, emotions, thanks).

        Uses a lightweight LLM call with the last exchange to produce
        a brief, natural acknowledgment instead of repeating info.
        """
        user_text = incoming.text or ""

        # Build minimal context: just the last assistant reply + user ack
        last_assistant = ""
        for msg in reversed(history[:-1]):
            if msg["role"] == "assistant":
                last_assistant = msg["content"][:200]
                break

        ack_prompt = (
            "你是民宿客服助理。客人剛才的訊息不是提問，只是禮貌回應或情緒表達。\n"
            "請用一句簡短、自然、溫暖的話回應即可（10-30字）。\n"
            "不要重複之前已經說過的資訊，不要主動補充新內容。\n"
            "範例：「好的沒問題！有需要再問我喔～」「是的，真不好意思呢！」"
            "「好喔，祝您有愉快的旅程！」"
        )
        user_content = ""
        if last_assistant:
            user_content += f"[你上一則回覆]\n{last_assistant}\n\n"
        user_content += f"[客人的回應]\n{user_text}"

        llm_response = await llm_service.generate(
            messages=[{"role": "user", "content": user_content}],
            system_prompt=ack_prompt,
        )

        reply_text = self._strip_greeting(llm_response.content)

        await self.conv_service.add_message(
            conversation.id,
            MessageRole.ASSISTANT,
            reply_text,
            llm_model=llm_response.model,
            token_usage=llm_response.input_tokens + llm_response.output_tokens,
        )
        return self._make_reply(incoming, reply_text)

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
