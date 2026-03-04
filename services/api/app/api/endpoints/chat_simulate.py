"""Simulated chat endpoint for testing the AI pipeline without LINE."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.base import ChannelType, IncomingMessage
from app.core.auth import verify_admin_token
from app.core.database import get_db
from app.services.ai_brain import AIBrain

router = APIRouter(prefix="/chat", tags=["chat-simulate"])


class ChatSimulateRequest(BaseModel):
    """Request body for simulated chat."""

    text: str
    session_id: str = "test-default"


class ChatSimulateResponse(BaseModel):
    """Response from simulated chat with debug info."""

    reply: str | None
    conversation_id: str | None = None
    debug: dict

    model_config = {"from_attributes": True}


@router.post("/simulate", response_model=ChatSimulateResponse)
async def simulate_chat(
    body: ChatSimulateRequest,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_token),
) -> ChatSimulateResponse:
    """Simulate a LINE chat message and return reply with debug info.

    Uses a virtual channel_user_id prefixed with 'sim_' to avoid
    conflicts with real LINE users.
    """
    channel_user_id = f"sim_{body.session_id}"

    incoming = IncomingMessage(
        channel=ChannelType.LINE,
        channel_user_id=channel_user_id,
        display_name=f"測試用戶 ({body.session_id})",
        text=body.text,
        message_type="text",
    )

    brain = AIBrain(db)
    outgoing, debug = await brain.handle_message_with_debug(incoming)

    # Retrieve conversation_id from the service
    conversation = await brain.conv_service.get_or_create_conversation(
        channel=ChannelType.LINE,
        channel_user_id=channel_user_id,
    )

    return ChatSimulateResponse(
        reply=outgoing.text if outgoing else None,
        conversation_id=str(conversation.id),
        debug=debug,
    )
