"""Tests for database session management."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestGetDb:
    """Tests for the get_db async generator."""

    @patch("app.core.database.async_session_factory")
    async def test_yields_session_and_commits(self, mock_factory):
        """Should yield a session and commit on success."""
        mock_session = AsyncMock()
        mock_session.commit = AsyncMock()
        mock_session.rollback = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)
        mock_factory.return_value = mock_session

        from app.core.database import get_db

        gen = get_db()
        session = await gen.__anext__()

        assert session is mock_session

        # Simulate normal completion (StopAsyncIteration triggers the finally)
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

        mock_session.commit.assert_awaited_once()
        mock_session.rollback.assert_not_awaited()

    @patch("app.core.database.async_session_factory")
    async def test_rolls_back_on_exception(self, mock_factory):
        """Should rollback the session if an exception is raised."""
        mock_session = AsyncMock()
        mock_session.commit = AsyncMock(side_effect=RuntimeError("db error"))
        mock_session.rollback = AsyncMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)
        mock_factory.return_value = mock_session

        from app.core.database import get_db

        gen = get_db()
        session = await gen.__anext__()

        assert session is mock_session

        # The commit will raise, triggering rollback
        with pytest.raises(RuntimeError, match="db error"):
            await gen.__anext__()

        mock_session.rollback.assert_awaited_once()
