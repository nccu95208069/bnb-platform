"""Document upload and management API endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.document import DocumentOut
from app.services.rag import RAGService

router = APIRouter(prefix="/documents", tags=["documents"])

ALLOWED_CONTENT_TYPES = {
    "text/plain",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


@router.post("/upload", response_model=DocumentOut)
async def upload_document(
    file: UploadFile,
    db: AsyncSession = Depends(get_db),
) -> DocumentOut:
    """Upload a document for RAG knowledge base.

    Supported formats: TXT, PDF, DOCX.
    The document will be chunked, embedded, and indexed for retrieval.
    """
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file.content_type}. Allowed: TXT, PDF, DOCX",
        )

    raw_content = await file.read()
    text_content = _extract_text(raw_content, file.content_type or "text/plain")

    if not text_content.strip():
        raise HTTPException(status_code=400, detail="Document contains no extractable text")

    rag_service = RAGService(db)
    document = await rag_service.ingest_document(
        filename=file.filename or "unknown",
        content=text_content,
        content_type=file.content_type or "text/plain",
    )

    return DocumentOut.model_validate(document)


@router.get("", response_model=list[DocumentOut])
async def list_documents(
    db: AsyncSession = Depends(get_db),
) -> list[DocumentOut]:
    """List all uploaded documents."""
    rag_service = RAGService(db)
    documents = await rag_service.list_documents()
    return [DocumentOut.model_validate(d) for d in documents]


@router.delete("/{document_id}")
async def delete_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Delete a document and all its chunks."""
    rag_service = RAGService(db)
    deleted = await rag_service.delete_document(document_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": "deleted"}


def _extract_text(raw: bytes, content_type: str) -> str:
    """Extract text content from raw file bytes.

    For PDF and DOCX, basic extraction is provided.
    For production, consider using libraries like PyPDF2 or python-docx.
    """
    if content_type == "text/plain":
        return raw.decode("utf-8", errors="replace")

    if content_type == "application/pdf":
        try:
            import io

            from PyPDF2 import PdfReader

            reader = PdfReader(io.BytesIO(raw))
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        except ImportError:
            return raw.decode("utf-8", errors="replace")

    if content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        try:
            import io

            import docx

            doc = docx.Document(io.BytesIO(raw))
            return "\n".join(p.text for p in doc.paragraphs)
        except ImportError:
            return raw.decode("utf-8", errors="replace")

    return raw.decode("utf-8", errors="replace")
