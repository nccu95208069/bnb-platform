"""AI Brain: channel-agnostic message orchestrator."""

import logging
import re
import uuid
from datetime import date, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.base import IncomingMessage, OutgoingMessage
from app.channels.registry import get_adapter
from app.models.conversation import MessageRole
from app.services.booking_query import BookingQueryService
from app.services.conversation import ConversationService
from app.services.llm import BNB_SYSTEM_PROMPT, llm_service
from app.services.pricing import BASE_PRICES
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
            history = await self.conv_service.get_conversation_history(conversation.id, limit=30)
            try:
                # Step 1: Reformulate follow-up into standalone question
                standalone_query = await self._reformulate_query(history, user_text)
                logger.info("Reformulated query: %s", standalone_query[:80])

                # Step 1.5: Handle non-question (acknowledgment/emotion)
                if standalone_query.startswith("__ACK__|"):
                    return await self._handle_ack(incoming, conversation, history)

                # Step 2: Dual RAG search (knowledge + QA examples)
                rag_service = RAGService(self.db)
                knowledge_context, qa_context = await rag_service.build_dual_context(
                    standalone_query
                )

                # Step 2.5: Booking context (if query is booking-related)
                booking_context = await self._build_booking_context(standalone_query)

                # Step 3: Build lightweight history summary (no LLM, free)
                is_new = await self.conv_service.is_new_session(conversation.id)
                summary = self._build_history_summary(history, is_new)

                # Step 4: Fresh single-turn call with natural language labels
                system_prompt = BNB_SYSTEM_PROMPT
                if summary:
                    system_prompt += f"\n對話摘要：{summary}"
                if not is_new:
                    system_prompt += "\n不要用「您好」「哈囉」「嗨」等招呼語開頭，直接回答問題"

                user_content = ""
                if knowledge_context:
                    user_content += f"以下是民宿的相關資訊：\n{knowledge_context}\n\n"
                if qa_context:
                    user_content += (
                        "以下是過去客服的回覆範例，請參考語氣和回覆方式：\n"
                        f"{qa_context}\n\n"
                    )
                if booking_context:
                    user_content += f"系統查詢結果：\n{booking_context}\n\n"
                user_content += f"客人的問題：\n{standalone_query}"

                llm_response = await llm_service.generate(
                    messages=[{"role": "user", "content": user_content}],
                    system_prompt=system_prompt,
                )

                llm_response.content = self._postprocess_response(
                    llm_response.content, is_new
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
            "謝謝",
            "感謝",
            "了解",
            "掰掰",
            "太可惜",
            "真不錯",
            "太好了",
            "好的",
            "沒問題",
            "知道了",
            "收到",
            "OK",
            "我懂了",
            "我知道了",
            "我晚點",
            "等等再",
            "我再",
            "好，我",
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
        """Build a summary with topic anchor + recent Q&A exchanges.

        Includes both questions AND answers so the LLM knows what it
        already said and avoids repeating the same information.
        """
        if is_new_session:
            return "新對話（可以用招呼語開頭）"
        user_questions = [msg["content"][:30] for msg in history[:-1] if msg["role"] == "user"]
        if not user_questions:
            return "新對話（可以用招呼語開頭）"

        # Topic anchor: first user question defines the conversation theme
        topic = f"本次對話主題：{user_questions[0]}"

        # All Q&A pairs in history (so LLM knows what it already said)
        exchanges: list[str] = []
        msgs = history[:-1]  # exclude current message
        for i, msg in enumerate(msgs):
            if msg["role"] == "user":
                q = msg["content"][:40]
                # Find the next assistant message as the answer
                a = ""
                if i + 1 < len(msgs) and msgs[i + 1]["role"] == "assistant":
                    a = msgs[i + 1]["content"][:80]
                exchanges.append(f"客人：{q} → 你的回答：{a}")

        exchanges_str = "\n".join(exchanges)
        return f"{topic}\n已回答過的內容（不要重複）：\n{exchanges_str}"

    @staticmethod
    def _strip_greeting(text: str) -> str:
        """Remove greeting prefixes from LLM responses.

        Strips common Chinese/English greetings that appear at the start
        of responses, along with trailing punctuation and whitespace.
        """
        pattern = r"^(您好|你好|哈囉|嗨|Hello|Hi)[！!~～。，,\s]*"
        result = re.sub(pattern, "", text, count=1, flags=re.IGNORECASE).lstrip()
        return result if result else text

    @staticmethod
    def _sanitize_response(text: str) -> str:
        """Remove any leaked internal markers from LLM response.

        Strips [方括號] tags, system labels, and other internal markers
        that should never appear in customer-facing replies.
        """
        # Remove [方括號] style tags like [參考資料], [訂房資料] etc.
        tag_names = (
            "參考資料|訂房資料|客人的問題|對話摘要"
            "|資料\\s*\\d+|系統查詢結果|民宿相關資訊|客服回覆範例"
        )
        text = re.sub(rf"\[(?:{tag_names})\]", "", text)
        # Remove any remaining [中文標籤] patterns that look like internal tags
        text = re.sub(r"\[(?:[\u4e00-\u9fff]+(?:\s*\d+)?)\]", "", text)
        # Clean up leftover whitespace
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        return text

    @staticmethod
    def _postprocess_response(text: str, is_new_session: bool) -> str:
        """Apply all post-processing steps to LLM response."""
        if not is_new_session:
            text = AIBrain._strip_greeting(text)
        text = AIBrain._sanitize_response(text)
        # Truncate overly long responses (keep under ~300 chars)
        if len(text) > 400:
            # Find a natural break point
            cutoff = text[:400].rfind("。")
            if cutoff > 200:
                text = text[: cutoff + 1]
            else:
                cutoff = text[:400].rfind("～")
                if cutoff > 200:
                    text = text[: cutoff + 1]
        return text

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

    # --- Booking context helpers ---

    _BOOKING_KEYWORDS = [
        "空房",
        "有房",
        "可以住",
        "能住",
        "還有房",
        "價格",
        "多少錢",
        "費用",
        "房價",
        "價位",
        "報價",
        "訂單",
        "預訂",
        "訂房",
        "預約",
        "幾號入住",
        "確認訂單",
        "check in",
        "check out",
        "入住",
        "退房",
    ]

    @classmethod
    def _is_booking_query(cls, query: str) -> bool:
        """Check if the query is related to booking/pricing/availability."""
        return any(kw in query.lower() for kw in cls._BOOKING_KEYWORDS)

    async def _build_booking_context(self, query: str) -> str | None:
        """Build booking context string if the query is booking-related."""
        parts: list[str] = []

        # Try to extract dates
        check_in, check_out = self._extract_dates(query)

        # Try to extract room number
        room = self._extract_room(query)

        # Try to extract guest name (for order lookup)
        guest_name = self._extract_guest_name(query)

        # Trigger booking context if keywords match OR dates/room/name extracted
        if not self._is_booking_query(query) and not check_in and not room and not guest_name:
            return None

        query_service = BookingQueryService(self.db)

        # Availability query
        if check_in and check_out:
            num_nights = (check_out - check_in).days
            result = await query_service.check_availability(check_in, check_out)
            available = result.available_rooms
            if available:
                parts.append(
                    f"{check_in.strftime('%m/%d')}入住～{check_out.strftime('%m/%d')}退房"
                    f"（共{num_nights}晚）"
                    f"空房：{', '.join(available)}（共{len(available)}間）"
                )
            else:
                parts.append(
                    f"{check_in.strftime('%m/%d')}入住～{check_out.strftime('%m/%d')}退房"
                    f"（共{num_nights}晚）目前沒有空房"
                )

            # Price quote
            if room and room in BASE_PRICES:
                stay = query_service.get_price_quote(room, check_in, check_out)
                night_details = "、".join(
                    f"{n.date.strftime('%m/%d')}({n.day_type.value})${n.price}" for n in stay.nights
                )
                parts.append(
                    f"{room}號房 報價（{num_nights}晚）：{night_details}，"
                    f"合計 ${stay.total}"
                )
            elif check_in and check_out:
                # Quote all available rooms
                for r in available[:3]:  # Limit to 3 rooms to keep context short
                    stay = query_service.get_price_quote(r, check_in, check_out)
                    parts.append(f"{r}號房（{num_nights}晚）合計 ${stay.total}")

        elif room and room in BASE_PRICES:
            # Price query without dates — show base prices
            prices = BASE_PRICES[room]
            parts.append(f"{room}號房 平日 ${prices['weekday']}／假日 ${prices['weekend']}")

        # Order lookup
        if guest_name:
            bookings = await query_service.find_booking(guest_name=guest_name)
            if bookings:
                for b in bookings[:3]:
                    parts.append(
                        f"訂單：{b.guest_name}，{b.room_number}號房，"
                        f"{b.check_in.strftime('%m/%d')}～{b.check_out.strftime('%m/%d')}，"
                        f"付款狀態：{b.payment_status.value}"
                    )
            else:
                parts.append(f"查無「{guest_name}」的訂單記錄")

        return "\n".join(parts) if parts else None

    @staticmethod
    def _extract_dates(query: str) -> tuple[date | None, date | None]:
        """Extract check-in and check-out dates from query text."""
        today = date.today()

        # Relative dates
        if "明天" in query:
            check_in = today + timedelta(days=1)
            check_out = check_in + timedelta(days=1)
            return check_in, check_out
        if "後天" in query:
            check_in = today + timedelta(days=2)
            check_out = check_in + timedelta(days=1)
            return check_in, check_out
        if "今天" in query or "今晚" in query:
            return today, today + timedelta(days=1)

        # Specific weekday: "下週三", "這週五", "週三", "禮拜三", "星期三"
        weekday_map = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
        weekday_pat = re.compile(
            r"(下週|下周|下個?禮拜|下個?星期|這週|這周|這個?禮拜|這個?星期|週|周|禮拜|星期)"
            r"([一二三四五六日天])"
        )
        wm = weekday_pat.search(query)
        if wm:
            prefix = wm.group(1)
            target_wd = weekday_map[wm.group(2)]
            current_wd = today.weekday()
            if "下" in prefix:
                # "下週X" → next week's X day
                days_to_next_mon = (7 - current_wd) % 7 or 7
                next_mon = today + timedelta(days=days_to_next_mon)
                check_in = next_mon + timedelta(days=target_wd)
            else:
                # "這週X" / "週X" → nearest upcoming occurrence
                days_ahead = (target_wd - current_wd) % 7 or 7
                check_in = today + timedelta(days=days_ahead)
            return check_in, check_in + timedelta(days=1)

        # "下週末" / "下個週末" (must check before "週末")
        next_weekend_pat = re.compile(r"下[週周]末|下個[週周]末")
        if next_weekend_pat.search(query):
            days_until_sat = (5 - today.weekday()) % 7
            if days_until_sat == 0:
                days_until_sat = 7
            sat = today + timedelta(days=days_until_sat + 7)
            return sat, sat + timedelta(days=1)

        # "這個週末" / "這週末" / "週末"
        if "週末" in query or "周末" in query:
            days_until_sat = (5 - today.weekday()) % 7
            if days_until_sat == 0:
                days_until_sat = 7
            sat = today + timedelta(days=days_until_sat)
            return sat, sat + timedelta(days=1)

        # Date range: "3/15-3/17", "3/15~3/17", "3月15日到3月17日"
        range_pat = re.compile(
            r"(\d{1,2})[/月](\d{1,2})[日號]?\s*[-~到至]\s*(\d{1,2})[/月](\d{1,2})[日號]?"
        )
        m = range_pat.search(query)
        if m:
            m1, d1, m2, d2 = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
            try:
                ci = _resolve_year(today, m1, d1)
                co = _resolve_year(today, m2, d2)
                if co <= ci:
                    co = date(ci.year + 1, m2, d2)
                return ci, co
            except ValueError:
                pass

        # Single date: "3/15", "3月15日", "03/15"
        single_pat = re.compile(r"(\d{1,2})[/月](\d{1,2})[日號]?")
        m = single_pat.search(query)
        if m:
            month, day = int(m.group(1)), int(m.group(2))
            try:
                ci = _resolve_year(today, month, day)
                return ci, ci + timedelta(days=1)
            except ValueError:
                pass

        return None, None

    @staticmethod
    def _extract_room(query: str) -> str | None:
        """Extract room number from query text."""
        m = re.search(r"(\d{3})\s*號?房?", query)
        if m and m.group(1) in BASE_PRICES:
            return m.group(1)
        return None

    @staticmethod
    def _extract_guest_name(query: str) -> str | None:
        """Extract guest name from query (e.g. '我姓王', '王先生')."""
        # "我姓X" pattern
        m = re.search(r"我姓([^\s，,。！!]{1,2})", query)
        if m:
            return m.group(1)

        # "X先生/小姐" pattern
        m = re.search(r"([^\s，,。！!]{1,3})(先生|小姐|女士)", query)
        if m:
            return m.group(1)

        return None

    async def handle_message_with_debug(
        self, incoming: IncomingMessage
    ) -> tuple[OutgoingMessage | None, dict]:
        """Same as handle_message but returns intermediate pipeline results.

        Returns:
            Tuple of (outgoing_message, debug_info_dict).
        """
        import time

        start_time = time.monotonic()
        user_text = incoming.text or ""
        debug: dict = {
            "original_query": user_text,
            "reformulated_query": user_text,
            "is_ack": False,
            "intent": "general",
            "extracted_dates": [],
            "extracted_room": None,
            "extracted_guest_name": None,
            "booking_context": None,
            "rag_context": None,
            "qa_examples": None,
            "llm_model": None,
            "llm_provider": None,
            "response_time_ms": 0,
        }

        conversation = await self.conv_service.get_or_create_conversation(
            channel=incoming.channel,
            channel_user_id=incoming.channel_user_id,
            display_name=incoming.display_name,
        )
        await self.conv_service.add_message(conversation.id, MessageRole.USER, user_text)

        if not await self.conv_service.is_ai_mode(conversation.id):
            debug["response_time_ms"] = int((time.monotonic() - start_time) * 1000)
            return None, debug

        history = await self.conv_service.get_conversation_history(conversation.id, limit=30)
        try:
            # Step 1: Reformulate
            standalone_query = await self._reformulate_query(history, user_text)
            debug["reformulated_query"] = standalone_query

            # Step 1.5: ACK detection
            if standalone_query.startswith("__ACK__|"):
                debug["is_ack"] = True
                debug["intent"] = "ack"
                outgoing = await self._handle_ack(incoming, conversation, history)
                debug["llm_model"] = "ack-handler"
                debug["response_time_ms"] = int((time.monotonic() - start_time) * 1000)
                return outgoing, debug

            # Step 2: Dual RAG search (knowledge + QA examples)
            rag_service = RAGService(self.db)
            knowledge_context, qa_context = await rag_service.build_dual_context(
                standalone_query
            )
            debug["rag_context"] = knowledge_context if knowledge_context else None
            debug["qa_examples"] = qa_context if qa_context else None

            # Step 2.5: Booking context
            check_in, check_out = self._extract_dates(standalone_query)
            room = self._extract_room(standalone_query)
            guest_name = self._extract_guest_name(standalone_query)
            debug["extracted_dates"] = (
                [d.isoformat() for d in [check_in, check_out] if d] if check_in else []
            )
            debug["extracted_room"] = room
            debug["extracted_guest_name"] = guest_name

            booking_context = await self._build_booking_context(standalone_query)
            debug["booking_context"] = booking_context

            # Determine intent
            if self._is_booking_query(standalone_query):
                if check_in and not room and not guest_name:
                    debug["intent"] = "availability"
                elif room or "多少" in standalone_query or "價" in standalone_query:
                    debug["intent"] = "pricing"
                elif guest_name or "訂單" in standalone_query:
                    debug["intent"] = "order_lookup"
                else:
                    debug["intent"] = "availability"
            else:
                debug["intent"] = "general"

            # Step 3: History summary
            is_new = await self.conv_service.is_new_session(conversation.id)
            summary = self._build_history_summary(history, is_new)

            # Step 4: LLM call with natural language labels
            system_prompt = BNB_SYSTEM_PROMPT
            if summary:
                system_prompt += f"\n對話摘要：{summary}"
            if not is_new:
                system_prompt += "\n不要用「您好」「哈囉」「嗨」等招呼語開頭，直接回答問題"

            user_content = ""
            if knowledge_context:
                user_content += f"以下是民宿的相關資訊：\n{knowledge_context}\n\n"
            if qa_context:
                user_content += (
                    "以下是過去客服的回覆範例，請參考語氣和回覆方式：\n"
                    f"{qa_context}\n\n"
                )
            if booking_context:
                user_content += f"系統查詢結果：\n{booking_context}\n\n"
            user_content += f"客人的問題：\n{standalone_query}"

            llm_response = await llm_service.generate(
                messages=[{"role": "user", "content": user_content}],
                system_prompt=system_prompt,
            )
            debug["llm_model"] = llm_response.model
            debug["llm_provider"] = llm_response.provider.value

            llm_response.content = self._postprocess_response(
                llm_response.content, is_new
            )

            await self.conv_service.add_message(
                conversation.id,
                MessageRole.ASSISTANT,
                llm_response.content,
                llm_model=llm_response.model,
                token_usage=llm_response.input_tokens + llm_response.output_tokens,
            )
            debug["response_time_ms"] = int((time.monotonic() - start_time) * 1000)
            return self._make_reply(incoming, llm_response.content), debug
        except RuntimeError:
            logger.exception("LLM generation failed (debug mode)")
            debug["response_time_ms"] = int((time.monotonic() - start_time) * 1000)
            error_reply = "抱歉，系統暫時無法回應，請稍後再試或聯繫民宿主人。"
            return self._make_reply(incoming, error_reply), debug

    @staticmethod
    def _make_reply(incoming: IncomingMessage, text: str) -> OutgoingMessage:
        """Create a reply OutgoingMessage from an IncomingMessage."""
        return OutgoingMessage(
            channel=incoming.channel,
            channel_user_id=incoming.channel_user_id,
            text=text,
            reply_token=incoming.reply_token,
        )


def _resolve_year(today: date, month: int, day: int) -> date:
    """Resolve a month/day to a full date, preferring future dates."""
    candidate = date(today.year, month, day)
    if candidate < today - timedelta(days=30):
        candidate = date(today.year + 1, month, day)
    return candidate
