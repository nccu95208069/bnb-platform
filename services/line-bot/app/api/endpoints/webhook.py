"""Multi-channel webhook dispatcher."""

import logging

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.base import ChannelType
from app.channels.registry import get_adapter
from app.core.database import get_db
from app.services.ai_brain import AIBrain

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhook"])


@router.post("/api/v1/webhook/{channel_name}")
async def handle_webhook(
    channel_name: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Handle incoming webhook events from any channel.

    Routes the request to the appropriate channel adapter for parsing,
    then processes each message through the AI Brain.
    """
    try:
        channel_type = ChannelType(channel_name)
    except ValueError:
        logger.warning("Unknown channel: %s", channel_name)
        return {"status": "error", "detail": f"Unknown channel: {channel_name}"}

    adapter = get_adapter(channel_type)
    messages = await adapter.parse_webhook(request)

    brain = AIBrain(db)
    for incoming in messages:
        try:
            outgoing = await brain.handle_message(incoming)
            if outgoing is not None:
                await adapter.send_message(outgoing)
        except Exception:
            logger.exception(
                "Error handling %s message from %s",
                incoming.message_type,
                incoming.channel_user_id,
            )

    return {"status": "ok"}
