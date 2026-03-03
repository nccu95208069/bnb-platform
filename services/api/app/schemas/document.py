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
    status: str
    error_message: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DocumentTextIn(BaseModel):
    """Schema for creating a document from plain text."""

    title: str
    content: str


class DocumentChunkOut(BaseModel):
    """Schema for a document chunk response."""

    id: uuid.UUID
    chunk_index: int
    content: str

    model_config = {"from_attributes": True}
