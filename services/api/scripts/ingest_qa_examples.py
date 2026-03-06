"""Ingest high-quality QA examples from parsed_conversations.json.

Usage:
    cd services/api
    python -m scripts.ingest_qa_examples

Reads parsed_conversations.json, selects ~500 high-quality QA pairs
covering diverse topics, and writes them to the DB as doc_type='qa_example'.
Each QA pair = 1 document = 1 chunk.
"""

import asyncio
import json
import logging
import sys
from pathlib import Path

# Ensure project root is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import async_session_factory  # noqa: E402
from app.models.document import (  # noqa: E402
    Document,
    DocumentStatus,
    DocumentType,
)
from app.services.rag import RAGService  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Configuration ---
MAX_EXAMPLES = 500
MIN_CUSTOMER_LEN = 4       # Filter out too-short customer messages
MIN_STAFF_LEN = 8          # Filter out too-short staff responses
MAX_STAFF_LEN = 500        # Filter out overly long responses (info dumps)

# Topics to ensure coverage
PRIORITY_TOPICS = [
    "訂房", "房型", "價格", "入住退房", "設施",
    "備品", "交通", "停車", "餐飲", "景點", "人數安排",
]

# Patterns that indicate the staff response contains raw template data
# (long URLs, form links, etc.) — skip these
SKIP_PATTERNS = [
    "https://forms.gle/",
    "https://reurl.cc/",
    "旅客手冊",
    "密碼鎖轉到",
    "大門密碼",
]


def load_conversations(path: Path) -> list[dict]:
    """Load and parse the conversations JSON file."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def is_good_qa(pair: dict) -> bool:
    """Filter for high-quality, concise QA pairs suitable as few-shot examples."""
    customer = pair.get("customer", "")
    staff = pair.get("staff", "")

    if len(customer) < MIN_CUSTOMER_LEN or len(staff) < MIN_STAFF_LEN:
        return False
    if len(staff) > MAX_STAFF_LEN:
        return False

    # Skip template-heavy responses
    return all(pattern not in staff for pattern in SKIP_PATTERNS)


def select_examples(conversations: list[dict]) -> list[dict]:
    """Select a diverse set of high-quality QA pairs."""
    # Collect all valid QA pairs with their topics
    all_pairs: list[tuple[dict, list[str]]] = []
    for conv in conversations:
        for pair in conv.get("qa_pairs", []):
            if is_good_qa(pair):
                topics = pair.get("topics", [])
                all_pairs.append((pair, topics))

    logger.info("Total valid QA pairs: %d", len(all_pairs))

    # First pass: ensure each priority topic has representation
    selected: list[dict] = []
    selected_set: set[str] = set()  # deduplicate by customer text
    per_topic_target = MAX_EXAMPLES // len(PRIORITY_TOPICS)

    for topic in PRIORITY_TOPICS:
        count = 0
        for pair, topics in all_pairs:
            if count >= per_topic_target:
                break
            key = pair["customer"][:60]
            if topic in topics and key not in selected_set:
                selected.append(pair)
                selected_set.add(key)
                count += 1

    # Second pass: fill remaining slots with any good examples
    remaining = MAX_EXAMPLES - len(selected)
    for pair, _ in all_pairs:
        if remaining <= 0:
            break
        key = pair["customer"][:60]
        if key not in selected_set:
            selected.append(pair)
            selected_set.add(key)
            remaining -= 1

    logger.info("Selected %d QA examples", len(selected))
    return selected


def format_qa_text(pair: dict) -> str:
    """Format a QA pair as a text string for embedding."""
    customer = pair["customer"].strip()
    staff = pair["staff"].strip()
    return f"客人：{customer}\n客服：{staff}"


async def ingest(examples: list[dict]) -> None:
    """Write QA examples to the database."""
    async with async_session_factory() as session:
        rag = RAGService(session)
        ingested = 0

        for i, pair in enumerate(examples):
            text = format_qa_text(pair)
            title = f"qa_example_{i:04d}"

            # Create document with qa_example type
            doc = Document(
                filename=title,
                content_type="text/plain",
                content=text,
                chunk_count=0,
                doc_type=DocumentType.QA_EXAMPLE,
                status=DocumentStatus.PENDING,
            )
            session.add(doc)
            await session.flush()

            # Generate embedding and create single chunk
            chunks = [text]  # Each QA pair is one chunk
            embeddings = await rag._generate_embeddings(chunks)

            from app.models.document import DocumentChunk

            chunk = DocumentChunk(
                document_id=doc.id,
                content=text,
                chunk_index=0,
                embedding=embeddings[0],
            )
            session.add(chunk)

            doc.chunk_count = 1
            doc.status = DocumentStatus.COMPLETED
            ingested += 1

            if (i + 1) % 50 == 0:
                await session.commit()
                logger.info("Progress: %d / %d", i + 1, len(examples))

        await session.commit()
        logger.info("Ingested %d QA examples successfully", ingested)


async def main() -> None:
    json_path = Path(__file__).resolve().parent.parent / "parsed_conversations.json"
    if not json_path.exists():
        logger.error("parsed_conversations.json not found at %s", json_path)
        sys.exit(1)

    conversations = load_conversations(json_path)
    examples = select_examples(conversations)

    if not examples:
        logger.error("No valid QA examples found")
        sys.exit(1)

    await ingest(examples)


if __name__ == "__main__":
    asyncio.run(main())
