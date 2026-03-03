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
如果參考資料中沒有相關資訊（例如附近便利商店、藥局、餐廳名稱、營業時間等），\
必須誠實說「這部分資訊我目前沒有，建議您直接詢問民宿主人」，\
絕對不可以自己編造店名、地址、距離或時間
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
