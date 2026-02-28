"""RAG pipeline: document chunking, embedding, and retrieval."""

import logging
import uuid

import httpx
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.document import Document, DocumentChunk

logger = logging.getLogger(__name__)


class RAGService:
    """Service for document ingestion and retrieval-augmented generation."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.chunk_size = settings.chunk_size
        self.chunk_overlap = settings.chunk_overlap

    # --- Document Ingestion ---

    async def ingest_document(
        self,
        filename: str,
        content: str,
        content_type: str,
    ) -> Document:
        """Ingest a document: store, chunk, embed, and index.

        Args:
            filename: Original filename.
            content: Extracted text content.
            content_type: MIME type of the original file.

        Returns:
            The created Document with chunks.
        """
        chunks = self._split_text(content)

        document = Document(
            filename=filename,
            content_type=content_type,
            content=content,
            chunk_count=len(chunks),
        )
        self.db.add(document)
        await self.db.flush()

        embeddings = await self._generate_embeddings(chunks)

        for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
            chunk = DocumentChunk(
                document_id=document.id,
                content=chunk_text,
                chunk_index=i,
                embedding=embedding,
            )
            self.db.add(chunk)

        await self.db.flush()
        logger.info("Ingested document %s with %d chunks", document.id, len(chunks))
        return document

    def _split_text(self, text: str) -> list[str]:
        """Split text into overlapping chunks."""
        if len(text) <= self.chunk_size:
            return [text]

        chunks = []
        start = 0
        while start < len(text):
            end = start + self.chunk_size
            chunk = text[start:end]
            chunks.append(chunk.strip())
            start += self.chunk_size - self.chunk_overlap

        return [c for c in chunks if c]

    async def _generate_embeddings(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings using the OpenAI embeddings API."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                json={
                    "model": settings.embedding_model,
                    "input": texts,
                },
                timeout=60.0,
            )
            response.raise_for_status()
            data = response.json()

        return [item["embedding"] for item in data["data"]]

    # --- Retrieval ---

    async def search(
        self,
        query: str,
        top_k: int = 3,
    ) -> list[DocumentChunk]:
        """Search for relevant document chunks using vector similarity.

        Args:
            query: The user's question.
            top_k: Number of chunks to return.

        Returns:
            List of most relevant DocumentChunks.
        """
        query_embedding = await self._generate_embeddings([query])

        stmt = (
            select(DocumentChunk)
            .order_by(DocumentChunk.embedding.cosine_distance(query_embedding[0]))
            .limit(top_k)
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def build_context(self, query: str, top_k: int = 3) -> str:
        """Build RAG context string from relevant document chunks.

        Args:
            query: The user's question.
            top_k: Number of chunks to retrieve.

        Returns:
            Formatted context string for LLM injection.
        """
        chunks = await self.search(query, top_k)

        if not chunks:
            return ""

        context_parts = []
        for i, chunk in enumerate(chunks, 1):
            context_parts.append(f"[資料 {i}]\n{chunk.content}")

        return "\n\n".join(context_parts)

    # --- Document Management ---

    async def list_documents(self) -> list[Document]:
        """List all documents."""
        stmt = select(Document).order_by(Document.created_at.desc())
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def delete_document(self, document_id: uuid.UUID) -> bool:
        """Delete a document and its chunks.

        Returns:
            True if the document was deleted, False if not found.
        """
        stmt = select(Document).where(Document.id == document_id)
        result = await self.db.execute(stmt)
        document = result.scalar_one_or_none()

        if document is None:
            return False

        await self.db.delete(document)
        await self.db.flush()
        logger.info("Deleted document %s", document_id)
        return True
