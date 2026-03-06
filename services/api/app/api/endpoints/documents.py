"""Document upload and management API endpoints."""

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import verify_admin_token
from app.core.database import get_db
from app.schemas.document import DocumentChunkOut, DocumentOut, DocumentTextIn
from app.services.rag import RAGService

router = APIRouter(prefix="/documents", tags=["documents"])

ALLOWED_CONTENT_TYPES = {
    "text/plain",
    "text/markdown",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


async def _process_document_task(document_id: uuid.UUID) -> None:
    """Background task wrapper for document processing."""
    await RAGService.process_document(document_id)


@router.post("/upload", response_model=list[DocumentOut])
async def upload_document(
    background_tasks: BackgroundTasks,
    files: list[UploadFile],
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_token),
) -> list[DocumentOut]:
    """Upload documents for RAG knowledge base.

    Supports: TXT, MD, PDF, DOCX. Accepts multiple files.
    Documents are created immediately and processed asynchronously.
    """
    results: list[DocumentOut] = []

    for file in files:
        content_type = file.content_type or "text/plain"

        # Handle .md files that browsers may send as text/plain
        if content_type == "text/plain" and file.filename and file.filename.endswith(".md"):
            content_type = "text/markdown"

        if content_type not in ALLOWED_CONTENT_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {content_type}. Allowed: TXT, MD, PDF, DOCX",
            )

        raw_content = await file.read()
        text_content = _extract_text(raw_content, content_type)

        if not text_content.strip():
            raise HTTPException(
                status_code=400,
                detail=f"Document '{file.filename}' contains no extractable text",
            )

        rag_service = RAGService(db)
        document = await rag_service.create_document(
            filename=file.filename or "unknown",
            content=text_content,
            content_type=content_type,
        )

        background_tasks.add_task(_process_document_task, document.id)
        results.append(DocumentOut.model_validate(document))

    return results


@router.post("/text", response_model=DocumentOut)
async def create_text_document(
    body: DocumentTextIn,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_token),
) -> DocumentOut:
    """Create a document from plain text input."""
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")

    rag_service = RAGService(db)
    document = await rag_service.create_document(
        filename=body.title,
        content=body.content,
        content_type="text/plain",
        doc_type=body.doc_type,
    )
    background_tasks.add_task(_process_document_task, document.id)
    return DocumentOut.model_validate(document)


@router.get("/{document_id}/chunks", response_model=list[DocumentChunkOut])
async def get_document_chunks(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[DocumentChunkOut]:
    """Get all chunks for a document."""
    rag_service = RAGService(db)
    chunks = await rag_service.get_chunks(document_id)
    return [DocumentChunkOut.model_validate(c) for c in chunks]


@router.get("/{document_id}", response_model=DocumentOut)
async def get_document(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> DocumentOut:
    """Get a single document by ID."""
    rag_service = RAGService(db)
    document = await rag_service.get_document(document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
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
    _admin: dict = Depends(verify_admin_token),
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
    if content_type in ("text/plain", "text/markdown"):
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
