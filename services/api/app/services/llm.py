"""LLM service layer with provider pattern supporting Claude and Gemini."""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum

import anthropic
from google import genai
from google.genai import types as genai_types

from app.core.config import settings

logger = logging.getLogger(__name__)


def _build_system_prompt() -> str:
    name_line = f"你是「{settings.bnb_name}」的智能客服助理。\n\n" if settings.bnb_name else ""
    return f"""{name_line}你是一位友善且專業的民宿智能客服助理。你的職責是：

1. 回答客人關於民宿的各種問題（房型、設施、價格、訂房方式等）
2. 提供周邊景點、交通、美食等旅遊資訊
3. 協助客人了解入住/退房流程和注意事項
4. 處理客人的特殊需求和問題

回應規則：
- 使用繁體中文回答
- 語氣親切友善，像朋友般的對話方式
- 回答要簡潔扼要，避免過長的回覆
- **嚴禁捏造資訊**：只能使用[參考資料]中明確提到的內容來回答。\
參考資料沒提到的東西一律不說，包括但不限於：房型特色、價格高低、\
店名、地址、距離、時間、設施有無。\
不確定就簡短回答「這部分資訊我目前沒有，建議您直接詢問民宿主人」，\
絕對不可以自己推測或編造
- **價格問題**：如果參考資料中沒有價格資訊，\
直接說「價格建議到官網或聯繫民宿主人確認喔」，一句話帶過即可，\
不要額外補充房型介紹或其他資訊
- **推薦問題**：只根據參考資料中明確的資訊做推薦，\
不要列出所有排列組合，針對客人需求推薦最適合的 1-2 個選項即可
- **意圖不明確時主動詢問**：這是最重要的規則。當客人的問題不夠具體時，\
不要急著給答案，而是先友善地追問釐清需求。例如：\
  - 客人說「想請問你們河景四人房」→ 回「請問想了解什麼呢？是想知道價格、設施，還是想預訂呢？」\
  - 客人說「3/19 301房」→ 回「請問您是想查詢空房狀況，還是想了解價格呢？」\
  - 客人說「你們有幾間房」→ 先簡單回答，再問「請問是在找特定類型的房間嗎？」\
一定要等客人明確說出需求後，再提供完整回答。不要自己腦補客人的意圖
- **空房查詢的對話流程**：當客人問「還有空房嗎」「有雙人房嗎」等籠統問題時，\
不要直接列出所有空房和價格。應該先引導：\
  1. 先告知有空房，然後詢問客人「請問有上網看過我們的房型嗎？有沒有特別喜歡的？」\
  2. 如果客人有偏好（如要浴缸、河景、預算考量），再針對需求推薦 1-2 間\
  3. 只有在客人明確要求「全部列出來」或已經表達過偏好後，才提供完整房型清單\
這樣的對話更自然，也能幫客人找到最適合的房間
- **訂房查詢**：當[訂房資料]中有空房或價格資訊時，據實回答，不要自己編造房間狀態
- **價格回覆**：當[訂房資料]中有價格時，直接告知客人每晚價格和總價
- **訂單確認**：當[訂房資料]中有訂單資訊時，確認訂單狀態（入住日、退房日、房號等）
- 涉及訂房確認或付款等重要事項時，建議客人直接與民宿主人確認
- 不要重複對話歷史中已經回答過的資訊，直接針對客人的最新問題作答
- 若參考資料中有與當前問題不直接相關的內容，不需要主動提及
- 不要用「您好」「哈囉」「嗨」等招呼語開頭，直接回答問題
- 只有在對話摘要標示「新對話」時才可以用招呼語
"""


BNB_SYSTEM_PROMPT = _build_system_prompt()


class LLMProviderType(str, Enum):
    """Supported LLM providers."""

    CLAUDE = "claude"
    GEMINI = "gemini"


@dataclass
class LLMResponse:
    """Response from an LLM provider."""

    content: str
    model: str
    input_tokens: int
    output_tokens: int
    provider: LLMProviderType


class LLMProvider(ABC):
    """Abstract base class for LLM providers."""

    @abstractmethod
    async def generate(
        self,
        messages: list[dict[str, str]],
        system_prompt: str | None = None,
    ) -> LLMResponse:
        """Generate a response from the LLM.

        Args:
            messages: Conversation history as list of {"role": ..., "content": ...}.
            system_prompt: Optional system prompt override.

        Returns:
            LLMResponse with content, model info, and token usage.
        """
        ...


class ClaudeProvider(LLMProvider):
    """Claude LLM provider using the Anthropic SDK."""

    def __init__(self) -> None:
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        self.model = settings.anthropic_model

    async def generate(
        self,
        messages: list[dict[str, str]],
        system_prompt: str | None = None,
    ) -> LLMResponse:
        response = await self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=system_prompt or BNB_SYSTEM_PROMPT,
            messages=messages,
        )

        content = response.content[0].text if response.content else ""

        return LLMResponse(
            content=content,
            model=self.model,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            provider=LLMProviderType.CLAUDE,
        )


class GeminiProvider(LLMProvider):
    """Gemini LLM provider using the Google Gen AI SDK."""

    def __init__(self) -> None:
        self.client = genai.Client(api_key=settings.google_gemini_api_key)
        self.model_name = settings.gemini_model

    async def generate(
        self,
        messages: list[dict[str, str]],
        system_prompt: str | None = None,
    ) -> LLMResponse:
        # Convert messages to Gemini Content format
        contents: list[genai_types.Content] = []
        for msg in messages:
            role = "user" if msg["role"] == "user" else "model"
            contents.append(
                genai_types.Content(
                    role=role,
                    parts=[genai_types.Part(text=msg["content"])],
                )
            )

        config = genai_types.GenerateContentConfig(
            system_instruction=system_prompt or BNB_SYSTEM_PROMPT,
            max_output_tokens=1024,
        )

        response = await self.client.aio.models.generate_content(
            model=self.model_name,
            contents=contents,
            config=config,
        )

        input_tokens = 0
        output_tokens = 0
        if response.usage_metadata:
            input_tokens = response.usage_metadata.prompt_token_count or 0
            output_tokens = response.usage_metadata.candidates_token_count or 0

        return LLMResponse(
            content=response.text or "",
            model=self.model_name,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            provider=LLMProviderType.GEMINI,
        )


class LLMService:
    """LLM service with provider switching and fallback support."""

    def __init__(self, primary: LLMProviderType = LLMProviderType.CLAUDE) -> None:
        self._providers: dict[LLMProviderType, LLMProvider] = {}
        self._primary = primary
        self._init_providers()

    def _init_providers(self) -> None:
        """Initialize available providers based on configuration."""
        if settings.anthropic_api_key:
            self._providers[LLMProviderType.CLAUDE] = ClaudeProvider()
        if settings.google_gemini_api_key:
            self._providers[LLMProviderType.GEMINI] = GeminiProvider()

        if not self._providers:
            logger.warning("No LLM providers configured. Set API keys in environment.")

    def _get_fallback(self, failed: LLMProviderType) -> LLMProviderType | None:
        """Get a fallback provider when the primary fails."""
        for provider_type in self._providers:
            if provider_type != failed:
                return provider_type
        return None

    async def generate(
        self,
        messages: list[dict[str, str]],
        system_prompt: str | None = None,
        provider: LLMProviderType | None = None,
    ) -> LLMResponse:
        """Generate an LLM response with automatic fallback.

        Args:
            messages: Conversation history.
            system_prompt: Optional system prompt override.
            provider: Force a specific provider (default uses primary).

        Returns:
            LLMResponse from the primary or fallback provider.

        Raises:
            RuntimeError: If no providers are available or all providers fail.
        """
        target = provider or self._primary

        if target not in self._providers:
            # Try any available provider
            if self._providers:
                target = next(iter(self._providers))
            else:
                raise RuntimeError("No LLM providers configured")

        try:
            return await self._providers[target].generate(messages, system_prompt)
        except Exception as e:
            logger.error("LLM provider %s failed: %s", target.value, e)

            fallback = self._get_fallback(target)
            if fallback and fallback in self._providers:
                logger.info("Falling back to %s", fallback.value)
                return await self._providers[fallback].generate(messages, system_prompt)

            raise RuntimeError(f"All LLM providers failed. Last error: {e}") from e


# Singleton instance
llm_service = LLMService()
