"""Tests for health check endpoint and basic app setup."""

import pytest
from httpx import AsyncClient


class TestHealthEndpoint:
    """Tests for the /health endpoint."""

    async def test_health_returns_ok(self, client: AsyncClient):
        """Health endpoint should return 200 with status ok."""
        response = await client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data == {"status": "ok"}

    async def test_health_response_content_type(self, client: AsyncClient):
        """Health endpoint should return JSON content type."""
        response = await client.get("/health")
        assert "application/json" in response.headers["content-type"]


class TestAppCreation:
    """Tests for FastAPI app factory."""

    async def test_app_has_docs_in_non_production(self, client: AsyncClient):
        """Non-production app should expose /docs."""
        response = await client.get("/docs")
        assert response.status_code == 200

    async def test_app_has_redoc_in_non_production(self, client: AsyncClient):
        """Non-production app should expose /redoc."""
        response = await client.get("/redoc")
        assert response.status_code == 200

    async def test_unknown_route_returns_404(self, client: AsyncClient):
        """Requesting an unknown path should return 404."""
        response = await client.get("/nonexistent")
        assert response.status_code == 404
