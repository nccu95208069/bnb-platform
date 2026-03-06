"""RAG pipeline: document chunking, embedding, and retrieval."""

import logging
import uuid

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import async_session_factory
from app.models.document import Document, DocumentChunk, DocumentStatus, DocumentType

logger = logging.getLogger(__name__)


class RAGService:
    """Service for document ingestion and retrieval-augmented generation."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.chunk_size = settings.chunk_size
        self.chunk_overlap = settings.chunk_overlap

    # --- Async Document Processing ---

    async def create_document(
        self,
        filename: str,
        content: str,
        content_type: str,
        doc_type: str = "knowledge",
    ) -> Document:
        """Create a document record with PENDING status (no chunking/embedding).

        Returns immediately so the caller can dispatch background processing.
        """
        doc_type_enum = DocumentType(doc_type)
        document = Document(
            filename=filename,
            content_type=content_type,
            content=content,
            chunk_count=0,
            doc_type=doc_type_enum,
            status=DocumentStatus.PENDING,
        )
        self.db.add(document)
        await self.db.commit()
        await self.db.refresh(document)
        logger.info("Created document %s with status PENDING", document.id)
        return document

    @staticmethod
    async def process_document(document_id: uuid.UUID) -> None:
        """Process a document: chunk, embed, and update status.

        Uses its own DB session via async_session_factory so it can run
        independently of the request lifecycle (e.g. in BackgroundTasks).
        """
        async with async_session_factory() as session:
            try:
                stmt = select(Document).where(Document.id == document_id)
                result = await session.execute(stmt)
                document = result.scalar_one_or_none()

                if document is None:
                    logger.error("Document %s not found for processing", document_id)
                    return

                document.status = DocumentStatus.PROCESSING
                await session.commit()

                rag = RAGService(session)
                chunks = rag._split_text(document.content)
                embeddings = await rag._generate_embeddings(chunks)

                for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings, strict=True)):
                    chunk = DocumentChunk(
                        document_id=document.id,
                        content=chunk_text,
                        chunk_index=i,
                        embedding=embedding,
                    )
                    session.add(chunk)

                document.chunk_count = len(chunks)
                document.status = DocumentStatus.COMPLETED
                await session.commit()
                logger.info("Processed document %s with %d chunks", document_id, len(chunks))

            except Exception:
                logger.exception("Failed to process document %s", document_id)
                # Re-fetch in case the session is invalidated
                async with async_session_factory() as err_session:
                    stmt = select(Document).where(Document.id == document_id)
                    result = await err_session.execute(stmt)
                    doc = result.scalar_one_or_none()
                    if doc is not None:
                        doc.status = DocumentStatus.FAILED
                        doc.error_message = "Processing failed – see server logs"
                        await err_session.commit()

    async def get_document(self, document_id: uuid.UUID) -> Document | None:
        """Get a single document by ID."""
        stmt = select(Document).where(Document.id == document_id)
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    # --- Document Ingestion (legacy, synchronous within request) ---

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

        for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings, strict=True)):
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
        """Generate embeddings using Google or OpenAI embeddings API."""
        if settings.google_gemini_api_key and not settings.openai_api_key:
            return await self._generate_embeddings_google(texts)
        return await self._generate_embeddings_openai(texts)

    async def _generate_embeddings_openai(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings using the OpenAI embeddings API."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                json={"model": settings.embedding_model, "input": texts},
                timeout=60.0,
            )
            response.raise_for_status()
            data = response.json()
        return [item["embedding"] for item in data["data"]]

    async def _generate_embeddings_google(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings using the Google Gemini embeddings API."""
        model = "gemini-embedding-001"
        requests = [
            {
                "model": f"models/{model}",
                "content": {"parts": [{"text": t}]},
                "outputDimensionality": 768,
            }
            for t in texts
        ]
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents",
                params={"key": settings.google_gemini_api_key},
                json={"requests": requests},
                timeout=60.0,
            )
            response.raise_for_status()
            data = response.json()
        return [item["values"] for item in data["embeddings"]]

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
            .where(DocumentChunk.embedding.cosine_distance(query_embedding[0]) < 0.5)
            .order_by(DocumentChunk.embedding.cosine_distance(query_embedding[0]))
            .limit(top_k)
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def search_by_type(
        self,
        query_embedding: list[float],
        doc_type: DocumentType,
        top_k: int = 3,
    ) -> list[DocumentChunk]:
        """Search for chunks filtered by document type.

        Args:
            query_embedding: Pre-computed embedding vector for the query.
            doc_type: Filter to only this document type.
            top_k: Number of chunks to return.

        Returns:
            List of most relevant DocumentChunks of the given type.
        """
        stmt = (
            select(DocumentChunk)
            .join(Document, DocumentChunk.document_id == Document.id)
            .where(
                Document.doc_type == doc_type,
                DocumentChunk.embedding.cosine_distance(query_embedding) < 0.5,
            )
            .order_by(DocumentChunk.embedding.cosine_distance(query_embedding))
            .limit(top_k)
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def build_dual_context(
        self,
        query: str,
        knowledge_top_k: int = 3,
        qa_top_k: int = 2,
    ) -> tuple[str, str]:
        """Build dual RAG context: knowledge chunks + QA examples.

        Uses a single embedding call for both searches.

        Args:
            query: The user's question.
            knowledge_top_k: Number of knowledge chunks to retrieve.
            qa_top_k: Number of QA examples to retrieve.

        Returns:
            Tuple of (knowledge_context, qa_examples_context).
        """
        query_embedding = (await self._generate_embeddings([query]))[0]

        knowledge_chunks = await self.search_by_type(
            query_embedding, DocumentType.KNOWLEDGE, knowledge_top_k
        )
        qa_chunks = await self.search_by_type(
            query_embedding, DocumentType.QA_EXAMPLE, qa_top_k
        )

        # Format knowledge context
        knowledge_context = ""
        if knowledge_chunks:
            parts = []
            for i, chunk in enumerate(knowledge_chunks, 1):
                parts.append(f"({i}) {chunk.content}")
            knowledge_context = "\n\n".join(parts)

        # Format QA examples
        qa_context = ""
        if qa_chunks:
            parts = []
            for chunk in qa_chunks:
                parts.append(f"---\n{chunk.content}\n---")
            qa_context = "\n".join(parts)

        return knowledge_context, qa_context

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

    async def get_chunks(self, document_id: uuid.UUID) -> list[DocumentChunk]:
        """Get all chunks for a document."""
        stmt = (
            select(DocumentChunk)
            .where(DocumentChunk.document_id == document_id)
            .order_by(DocumentChunk.chunk_index)
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

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
