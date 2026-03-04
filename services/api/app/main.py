"""FastAPI application entry point."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.channels.registry import init_adapters
from app.core.config import settings

logger = logging.getLogger(__name__)

_SYNC_INTERVAL_SECONDS = 300  # 5 minutes


async def _sheets_sync_loop() -> None:
    """Background loop: sync Google Sheets bookings every 5 minutes."""
    from app.services.sheets_sync import sheets_sync_service

    # Initial sync on startup
    try:
        await sheets_sync_service.sync()
    except Exception:
        logger.exception("Initial sheets sync failed")

    while True:
        await asyncio.sleep(_SYNC_INTERVAL_SECONDS)
        try:
            await sheets_sync_service.sync()
        except Exception:
            logger.exception("Sheets sync failed")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: startup and shutdown events."""
    # Startup
    init_adapters()

    # Start sheets sync background task if configured
    sync_task: asyncio.Task | None = None  # type: ignore[type-arg]
    if settings.google_sheet_id and settings.google_service_account_json:
        sync_task = asyncio.create_task(_sheets_sync_loop())
        logger.info("Sheets sync background task started")

    yield

    # Shutdown
    if sync_task:
        sync_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sync_task

    from app.core.database import engine

    await engine.dispose()


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="BnB AI Concierge API",
        description="Multi-channel AI-powered customer service for BnB",
        version="0.2.0",
        lifespan=lifespan,
        docs_url="/docs" if not settings.is_production else None,
        redoc_url="/redoc" if not settings.is_production else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router)

    return app


app = create_app()
