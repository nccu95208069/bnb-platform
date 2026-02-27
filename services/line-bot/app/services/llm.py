"""LLM service layer with provider pattern supporting Claude and Gemini."""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum

import anthropic
import google.generativeai as genai

from app.core.config import settings

logger = logging.getLogger(__name__)

BNB_SYSTEM_PROMPT = """你是一位友善且專業的民宿智能客服助理。你的職責是：

1. 回答客人關於民宿的各種問題（房型、設施、價格、訂房方式等）
2. 提供周邊景點、交通、美食等旅遊資訊
3. 協助客人了解入住/退房流程和注意事項
4. 處理客人的特殊需求和問題

回應規則：
- 使用繁體中文回答
- 語氣親切友善，像朋友般的對話方式
- 回答要簡潔扼要，避免過長的回覆
- 如果不確定答案，誠實告知並建議聯繫民宿主人
- 涉及訂房確認或付款等重要事項時，建議客人直接與民宿主人確認
"""


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
    """Gemini LLM provider using the Google Generative AI SDK."""

    _configured = False

    def __init__(self) -> None:
        if not GeminiProvider._configured:
            genai.configure(api_key=settings.google_gemini_api_key)
            GeminiProvider._configured = True
        self.model_name = settings.gemini_model

    async def generate(
        self,
        messages: list[dict[str, str]],
        system_prompt: str | None = None,
    ) -> LLMResponse:
        model = genai.GenerativeModel(
            model_name=self.model_name,
            system_instruction=system_prompt or BNB_SYSTEM_PROMPT,
        )

        # Convert messages to Gemini format
        gemini_history = []
        for msg in messages[:-1]:
            role = "user" if msg["role"] == "user" else "model"
            gemini_history.append({"role": role, "parts": [msg["content"]]})

        chat = model.start_chat(history=gemini_history)

        last_message = messages[-1]["content"] if messages else ""
        response = await chat.send_message_async(last_message)

        # Gemini doesn't provide exact token counts in the same way;
        # use count_tokens for an estimate
        input_tokens = 0
        output_tokens = 0
        if hasattr(response, "usage_metadata") and response.usage_metadata:
            input_tokens = getattr(response.usage_metadata, "prompt_token_count", 0)
            output_tokens = getattr(response.usage_metadata, "candidates_token_count", 0)

        return LLMResponse(
            content=response.text,
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
