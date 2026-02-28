"""Pydantic schemas for document API."""

import uuid
from datetime import datetime

from pydantic import BaseModel


class DocumentOut(BaseModel):
    """Schema for a document response."""

    id: uuid.UUID
    filename: str
    content_type: str
    chunk_count: int
    created_at: datetime

    model_config = {"from_attributes": True}
