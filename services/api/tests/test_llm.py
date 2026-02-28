"""Tests for the LLM service layer (providers, fallback, token tracking)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.llm import (
    BNB_SYSTEM_PROMPT,
    ClaudeProvider,
    GeminiProvider,
    LLMProviderType,
    LLMResponse,
    LLMService,
)


# ---------------------------------------------------------------------------
# LLMResponse dataclass tests
# ---------------------------------------------------------------------------


class TestLLMResponse:
    """Tests for the LLMResponse dataclass."""

    def test_llm_response_creation(self):
        """LLMResponse should store all fields."""
        resp = LLMResponse(
            content="Hello",
            model="claude-sonnet-4-5-20250929",
            input_tokens=100,
            output_tokens=50,
            provider=LLMProviderType.CLAUDE,
        )
        assert resp.content == "Hello"
        assert resp.model == "claude-sonnet-4-5-20250929"
        assert resp.input_tokens == 100
        assert resp.output_tokens == 50
        assert resp.provider == LLMProviderType.CLAUDE

    def test_total_tokens(self):
        """Token counts should be accessible for usage tracking."""
        resp = LLMResponse(
            content="Hi",
            model="gemini-2.0-flash",
            input_tokens=80,
            output_tokens=40,
            provider=LLMProviderType.GEMINI,
        )
        assert resp.input_tokens + resp.output_tokens == 120


# ---------------------------------------------------------------------------
# LLMProviderType enum tests
# ---------------------------------------------------------------------------


class TestLLMProviderType:
    """Tests for LLM provider type enum."""

    def test_provider_values(self):
        """Provider enum should have correct values."""
        assert LLMProviderType.CLAUDE.value == "claude"
        assert LLMProviderType.GEMINI.value == "gemini"

    def test_provider_is_str(self):
        """Provider type should be a string enum."""
        assert isinstance(LLMProviderType.CLAUDE, str)


# ---------------------------------------------------------------------------
# ClaudeProvider tests
# ---------------------------------------------------------------------------


class TestClaudeProvider:
    """Tests for ClaudeProvider (Anthropic SDK)."""

    @patch("app.services.llm.settings")
    @patch("app.services.llm.anthropic.AsyncAnthropic")
    async def test_generate_returns_llm_response(self, MockAnthropic, mock_settings):
        """ClaudeProvider.generate should return a properly formatted LLMResponse."""
        mock_settings.anthropic_api_key = "test-key"
        mock_settings.anthropic_model = "claude-sonnet-4-5-20250929"

        mock_client = AsyncMock()
        MockAnthropic.return_value = mock_client

        mock_api_response = MagicMock()
        mock_api_response.content = [MagicMock(text="Mocked Claude response")]
        mock_api_response.usage = MagicMock(input_tokens=100, output_tokens=50)
        mock_client.messages.create = AsyncMock(return_value=mock_api_response)

        provider = ClaudeProvider()
        messages = [{"role": "user", "content": "Hello"}]
        result = await provider.generate(messages)

        assert isinstance(result, LLMResponse)
        assert result.content == "Mocked Claude response"
        assert result.model == "claude-sonnet-4-5-20250929"
        assert result.input_tokens == 100
        assert result.output_tokens == 50
        assert result.provider == LLMProviderType.CLAUDE

    @patch("app.services.llm.settings")
    @patch("app.services.llm.anthropic.AsyncAnthropic")
    async def test_generate_uses_custom_system_prompt(self, MockAnthropic, mock_settings):
        """ClaudeProvider should pass a custom system prompt to the API."""
        mock_settings.anthropic_api_key = "test-key"
        mock_settings.anthropic_model = "claude-sonnet-4-5-20250929"

        mock_client = AsyncMock()
        MockAnthropic.return_value = mock_client

        mock_api_response = MagicMock()
        mock_api_response.content = [MagicMock(text="OK")]
        mock_api_response.usage = MagicMock(input_tokens=10, output_tokens=5)
        mock_client.messages.create = AsyncMock(return_value=mock_api_response)

        provider = ClaudeProvider()
        custom_prompt = "You are a test assistant."
        await provider.generate([{"role": "user", "content": "Hi"}], system_prompt=custom_prompt)

        call_kwargs = mock_client.messages.create.call_args[1]
        assert call_kwargs["system"] == custom_prompt

    @patch("app.services.llm.settings")
    @patch("app.services.llm.anthropic.AsyncAnthropic")
    async def test_generate_uses_default_system_prompt(self, MockAnthropic, mock_settings):
        """ClaudeProvider should use BNB_SYSTEM_PROMPT by default."""
        mock_settings.anthropic_api_key = "test-key"
        mock_settings.anthropic_model = "claude-sonnet-4-5-20250929"

        mock_client = AsyncMock()
        MockAnthropic.return_value = mock_client

        mock_api_response = MagicMock()
        mock_api_response.content = [MagicMock(text="OK")]
        mock_api_response.usage = MagicMock(input_tokens=10, output_tokens=5)
        mock_client.messages.create = AsyncMock(return_value=mock_api_response)

        provider = ClaudeProvider()
        await provider.generate([{"role": "user", "content": "Hi"}])

        call_kwargs = mock_client.messages.create.call_args[1]
        assert call_kwargs["system"] == BNB_SYSTEM_PROMPT

    @patch("app.services.llm.settings")
    @patch("app.services.llm.anthropic.AsyncAnthropic")
    async def test_generate_empty_content_returns_empty_string(self, MockAnthropic, mock_settings):
        """If the API returns no content, the response content should be empty."""
        mock_settings.anthropic_api_key = "test-key"
        mock_settings.anthropic_model = "claude-sonnet-4-5-20250929"

        mock_client = AsyncMock()
        MockAnthropic.return_value = mock_client

        mock_api_response = MagicMock()
        mock_api_response.content = []
        mock_api_response.usage = MagicMock(input_tokens=10, output_tokens=0)
        mock_client.messages.create = AsyncMock(return_value=mock_api_response)

        provider = ClaudeProvider()
        result = await provider.generate([{"role": "user", "content": "Hi"}])
        assert result.content == ""

    @patch("app.services.llm.settings")
    @patch("app.services.llm.anthropic.AsyncAnthropic")
    async def test_generate_propagates_api_errors(self, MockAnthropic, mock_settings):
        """API errors should propagate as exceptions."""
        mock_settings.anthropic_api_key = "test-key"
        mock_settings.anthropic_model = "claude-sonnet-4-5-20250929"

        mock_client = AsyncMock()
        MockAnthropic.return_value = mock_client
        mock_client.messages.create = AsyncMock(side_effect=Exception("API rate limit"))

        provider = ClaudeProvider()
        with pytest.raises(Exception, match="API rate limit"):
            await provider.generate([{"role": "user", "content": "Hi"}])


# ---------------------------------------------------------------------------
# GeminiProvider tests
# ---------------------------------------------------------------------------


class TestGeminiProvider:
    """Tests for GeminiProvider (Google Gen AI SDK)."""

    @patch("app.services.llm.settings")
    @patch("app.services.llm.genai.Client")
    async def test_generate_returns_llm_response(self, MockClient, mock_settings):
        """GeminiProvider.generate should return a properly formatted LLMResponse."""
        mock_settings.google_gemini_api_key = "test-key"
        mock_settings.gemini_model = "gemini-2.0-flash"

        mock_response = MagicMock()
        mock_response.text = "Mocked Gemini response"
        mock_response.usage_metadata = MagicMock(
            prompt_token_count=80,
            candidates_token_count=40,
        )

        mock_client = MagicMock()
        mock_client.aio.models.generate_content = AsyncMock(return_value=mock_response)
        MockClient.return_value = mock_client

        provider = GeminiProvider()
        messages = [{"role": "user", "content": "Hello"}]
        result = await provider.generate(messages)

        assert isinstance(result, LLMResponse)
        assert result.content == "Mocked Gemini response"
        assert result.model == "gemini-2.0-flash"
        assert result.input_tokens == 80
        assert result.output_tokens == 40
        assert result.provider == LLMProviderType.GEMINI

    @patch("app.services.llm.settings")
    @patch("app.services.llm.genai.Client")
    async def test_generate_converts_message_history(self, MockClient, mock_settings):
        """GeminiProvider should convert chat history to Gemini format."""
        mock_settings.google_gemini_api_key = "test-key"
        mock_settings.gemini_model = "gemini-2.0-flash"

        mock_response = MagicMock()
        mock_response.text = "OK"
        mock_response.usage_metadata = None

        mock_client = MagicMock()
        mock_client.aio.models.generate_content = AsyncMock(return_value=mock_response)
        MockClient.return_value = mock_client

        provider = GeminiProvider()
        messages = [
            {"role": "user", "content": "First msg"},
            {"role": "assistant", "content": "First response"},
            {"role": "user", "content": "Second msg"},
        ]
        await provider.generate(messages)

        # Verify generate_content was called with all messages as contents
        call_kwargs = mock_client.aio.models.generate_content.call_args[1]
        contents = call_kwargs["contents"]
        assert len(contents) == 3
        assert contents[0].role == "user"
        assert contents[1].role == "model"  # assistant -> model
        assert contents[2].role == "user"

    @patch("app.services.llm.settings")
    @patch("app.services.llm.genai.Client")
    async def test_generate_handles_missing_usage_metadata(self, MockClient, mock_settings):
        """Token counts should default to 0 when usage_metadata is missing."""
        mock_settings.google_gemini_api_key = "test-key"
        mock_settings.gemini_model = "gemini-2.0-flash"

        mock_response = MagicMock()
        mock_response.text = "OK"
        mock_response.usage_metadata = None

        mock_client = MagicMock()
        mock_client.aio.models.generate_content = AsyncMock(return_value=mock_response)
        MockClient.return_value = mock_client

        provider = GeminiProvider()
        result = await provider.generate([{"role": "user", "content": "Hi"}])

        assert result.input_tokens == 0
        assert result.output_tokens == 0


# ---------------------------------------------------------------------------
# LLMService tests (provider switching, fallback)
# ---------------------------------------------------------------------------


class TestLLMService:
    """Tests for the LLMService with fallback logic."""

    def _make_service_with_mocks(
        self,
        claude_response: LLMResponse | Exception | None = None,
        gemini_response: LLMResponse | Exception | None = None,
    ) -> LLMService:
        """Create an LLMService with mock providers."""
        service = LLMService.__new__(LLMService)
        service._providers = {}
        service._primary = LLMProviderType.CLAUDE

        if claude_response is not None:
            mock_claude = AsyncMock(spec=ClaudeProvider)
            if isinstance(claude_response, Exception):
                mock_claude.generate = AsyncMock(side_effect=claude_response)
            else:
                mock_claude.generate = AsyncMock(return_value=claude_response)
            service._providers[LLMProviderType.CLAUDE] = mock_claude

        if gemini_response is not None:
            mock_gemini = AsyncMock(spec=GeminiProvider)
            if isinstance(gemini_response, Exception):
                mock_gemini.generate = AsyncMock(side_effect=gemini_response)
            else:
                mock_gemini.generate = AsyncMock(return_value=gemini_response)
            service._providers[LLMProviderType.GEMINI] = mock_gemini

        return service

    async def test_generate_uses_primary_provider(self):
        """LLMService should use the primary provider by default."""
        expected = LLMResponse(
            content="Claude says hi",
            model="claude-sonnet-4-5-20250929",
            input_tokens=50,
            output_tokens=20,
            provider=LLMProviderType.CLAUDE,
        )
        service = self._make_service_with_mocks(claude_response=expected)
        messages = [{"role": "user", "content": "Hello"}]

        result = await service.generate(messages=messages)

        assert result.content == "Claude says hi"
        assert result.provider == LLMProviderType.CLAUDE

    async def test_generate_with_explicit_provider(self):
        """LLMService should use the explicitly requested provider."""
        gemini_resp = LLMResponse(
            content="Gemini says hi",
            model="gemini-2.0-flash",
            input_tokens=40,
            output_tokens=15,
            provider=LLMProviderType.GEMINI,
        )
        claude_resp = LLMResponse(
            content="Claude says hi",
            model="claude-sonnet-4-5-20250929",
            input_tokens=50,
            output_tokens=20,
            provider=LLMProviderType.CLAUDE,
        )
        service = self._make_service_with_mocks(
            claude_response=claude_resp,
            gemini_response=gemini_resp,
        )

        result = await service.generate(
            messages=[{"role": "user", "content": "Hi"}],
            provider=LLMProviderType.GEMINI,
        )
        assert result.provider == LLMProviderType.GEMINI

    async def test_fallback_when_primary_fails(self):
        """When the primary provider fails, fallback to the other provider."""
        gemini_resp = LLMResponse(
            content="Gemini fallback",
            model="gemini-2.0-flash",
            input_tokens=40,
            output_tokens=15,
            provider=LLMProviderType.GEMINI,
        )
        service = self._make_service_with_mocks(
            claude_response=Exception("Claude API down"),
            gemini_response=gemini_resp,
        )

        result = await service.generate(messages=[{"role": "user", "content": "Hi"}])
        assert result.content == "Gemini fallback"
        assert result.provider == LLMProviderType.GEMINI

    async def test_raises_when_all_providers_fail(self):
        """When all providers fail, the fallback exception should propagate."""
        service = self._make_service_with_mocks(
            claude_response=Exception("Claude down"),
            gemini_response=Exception("Gemini down"),
        )

        with pytest.raises(Exception, match="Gemini down"):
            await service.generate(messages=[{"role": "user", "content": "Hi"}])

    async def test_raises_when_no_providers_configured(self):
        """When no providers exist, raise RuntimeError."""
        service = self._make_service_with_mocks()  # No providers

        with pytest.raises(RuntimeError, match="No LLM providers configured"):
            await service.generate(messages=[{"role": "user", "content": "Hi"}])

    async def test_single_provider_no_fallback(self):
        """With only one provider, failure should raise directly."""
        service = self._make_service_with_mocks(
            claude_response=Exception("Claude down"),
        )

        with pytest.raises(RuntimeError, match="All LLM providers failed"):
            await service.generate(messages=[{"role": "user", "content": "Hi"}])

    async def test_unavailable_target_falls_back_to_any(self):
        """If the target provider is not configured, use any available one."""
        gemini_resp = LLMResponse(
            content="Gemini response",
            model="gemini-2.0-flash",
            input_tokens=40,
            output_tokens=15,
            provider=LLMProviderType.GEMINI,
        )
        service = self._make_service_with_mocks(gemini_response=gemini_resp)
        # Primary is CLAUDE but only GEMINI is available
        result = await service.generate(messages=[{"role": "user", "content": "Hi"}])
        assert result.provider == LLMProviderType.GEMINI

    async def test_system_prompt_passed_to_provider(self):
        """System prompt should be forwarded to the provider."""
        expected = LLMResponse(
            content="OK",
            model="claude-sonnet-4-5-20250929",
            input_tokens=10,
            output_tokens=5,
            provider=LLMProviderType.CLAUDE,
        )
        service = self._make_service_with_mocks(claude_response=expected)
        custom_prompt = "Custom system prompt"

        await service.generate(
            messages=[{"role": "user", "content": "Hi"}],
            system_prompt=custom_prompt,
        )

        provider = service._providers[LLMProviderType.CLAUDE]
        provider.generate.assert_awaited_once_with(
            [{"role": "user", "content": "Hi"}],
            custom_prompt,
        )

    def test_get_fallback_returns_other_provider(self):
        """_get_fallback should return the other provider."""
        service = self._make_service_with_mocks(
            claude_response=LLMResponse("", "", 0, 0, LLMProviderType.CLAUDE),
            gemini_response=LLMResponse("", "", 0, 0, LLMProviderType.GEMINI),
        )
        assert service._get_fallback(LLMProviderType.CLAUDE) == LLMProviderType.GEMINI
        assert service._get_fallback(LLMProviderType.GEMINI) == LLMProviderType.CLAUDE

    def test_get_fallback_returns_none_with_single_provider(self):
        """_get_fallback should return None when only one provider exists."""
        service = self._make_service_with_mocks(
            claude_response=LLMResponse("", "", 0, 0, LLMProviderType.CLAUDE),
        )
        assert service._get_fallback(LLMProviderType.CLAUDE) is None


# ---------------------------------------------------------------------------
# BNB_SYSTEM_PROMPT tests
# ---------------------------------------------------------------------------


class TestSystemPrompt:
    """Tests for the default system prompt."""

    def test_system_prompt_is_non_empty(self):
        """BNB_SYSTEM_PROMPT should be a non-empty string."""
        assert isinstance(BNB_SYSTEM_PROMPT, str)
        assert len(BNB_SYSTEM_PROMPT) > 0

    def test_system_prompt_uses_traditional_chinese(self):
        """System prompt should contain traditional Chinese characters."""
        assert "繁體中文" in BNB_SYSTEM_PROMPT

    def test_system_prompt_mentions_bnb(self):
        """System prompt should reference bed-and-breakfast context."""
        assert "民宿" in BNB_SYSTEM_PROMPT
