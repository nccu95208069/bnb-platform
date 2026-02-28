"""Application configuration using pydantic-settings."""

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Application
    app_env: str = "development"
    app_debug: bool = False
    app_host: str = "0.0.0.0"
    app_port: int = 8000

    # CORS - comma-separated allowed origins for production
    cors_origins: str = ""

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/bnb_linebot"

    # LINE Bot
    line_channel_secret: str = ""
    line_channel_access_token: str = ""

    # LLM - Claude
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-5-20250929"

    # LLM - Gemini
    google_gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"

    # Google Calendar / Sheets
    google_service_account_json: str = ""
    google_calendar_id: str = ""
    google_sheet_id: str = ""

    # RAG / Embedding (OpenAI API for embeddings)
    openai_api_key: str = ""
    embedding_model: str = "text-embedding-3-small"
    chunk_size: int = 512
    chunk_overlap: int = 50

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def allowed_origins(self) -> list[str]:
        """Parse CORS_ORIGINS into a list."""
        if self.cors_origins:
            return [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        return ["*"] if not self.is_production else []

    @property
    def has_line_channel(self) -> bool:
        """Check if LINE channel is fully configured."""
        return bool(self.line_channel_secret and self.line_channel_access_token)

    @property
    def has_any_channel(self) -> bool:
        """Check if at least one messaging channel is configured."""
        return self.has_line_channel

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        """Ensure critical API keys are set in production."""
        if self.is_production:
            missing = []
            if not self.has_any_channel:
                missing.append(
                    "At least one channel (e.g. LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN)"
                )
            if not self.anthropic_api_key and not self.google_gemini_api_key:
                missing.append("ANTHROPIC_API_KEY or GOOGLE_GEMINI_API_KEY")
            if not self.cors_origins:
                missing.append("CORS_ORIGINS")
            if missing:
                raise ValueError(
                    f"Production requires these environment variables: {', '.join(missing)}"
                )
        return self


settings = Settings()
