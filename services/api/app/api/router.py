"""API router aggregating all endpoint routers."""

from fastapi import APIRouter

from app.api.endpoints import conversations, documents, health, webhook

api_router = APIRouter()

api_router.include_router(health.router, tags=["health"])
api_router.include_router(webhook.router)
api_router.include_router(conversations.router, prefix="/api/v1")
api_router.include_router(documents.router, prefix="/api/v1")
