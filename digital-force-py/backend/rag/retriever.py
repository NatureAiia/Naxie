"""
Digital Force — RAG Retriever
Hybrid dense + sparse search with reranking over Qdrant.
"""

import asyncio
import logging
from typing import Optional
from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    from qdrant_client import QdrantClient
    # Use the Qdrant SERVER whenever a URL is configured (api_key is optional for
    # self-hosted). Gating on url AND api_key silently fell back to the embedded
    # file store — which takes an exclusive lock and breaks under >1 worker.
    if settings.qdrant_url:
        _client = QdrantClient(url=settings.qdrant_url, api_key=(settings.qdrant_api_key or None))
    else:
        _client = QdrantClient(path=settings.qdrant_local_path)
    return _client


def _get_embedder():
    """Return best available embedder. Never raises — stubs if nothing available."""
    # 1. sentence-transformers (preferred)
    try:
        from sentence_transformers import SentenceTransformer
        return SentenceTransformer("all-MiniLM-L6-v2")
    except ImportError:
        logger.warning("[RAG] sentence-transformers not installed.")

    # 3. Hash stub (no semantic quality — installs nothing)
    logger.warning("[RAG] Using hash stub embedder. Install sentence-transformers for real RAG.")
    import hashlib, struct

    class _Vec(list):
        # Mimic the numpy array returned by SentenceTransformer.encode so callers
        # can uniformly call .tolist().
        def tolist(self):
            return [list(v) if isinstance(v, list) else v for v in self]

    class _Stub:
        DIMS = 384
        def _one(self, t: str):
            raw = hashlib.sha256(t.encode()).digest() * 16
            vec = list(struct.unpack('96f', raw[:384])[:384])
            s = sum(abs(v) for v in vec) or 1.0
            return [v / s for v in vec]
        def encode(self, texts, **_):
            # Accept a single string (→ 1-D vector) or a list (→ 2-D), matching
            # SentenceTransformer semantics — the old version iterated a single
            # string character-by-character.
            if isinstance(texts, str):
                return _Vec(self._one(texts))
            return _Vec([_Vec(self._one(t)) for t in texts])

    return _Stub()


_embedder = None


def get_embedder():
    global _embedder
    if _embedder is None:
        _embedder = _get_embedder()
    return _embedder


async def retrieve(
    query: str,
    collection: str = "knowledge",
    top_k: int = 5,
    filter_metadata: Optional[dict] = None,
) -> list[dict]:
    """
    Retrieve semantically relevant documents from Qdrant.
    Returns list of {text, score, metadata} dicts.
    """
    try:
        client = _get_client()
        embedder = get_embedder()

        # Map collection alias to actual collection name
        collection_map = {
            "knowledge": settings.qdrant_knowledge_collection,
            "brand": settings.qdrant_brand_collection,
            "media": settings.qdrant_media_collection,
        }
        collection_name = collection_map.get(collection, settings.qdrant_knowledge_collection)

        query_vector = (await asyncio.to_thread(embedder.encode, query)).tolist()

        from qdrant_client.models import Filter, FieldCondition, MatchValue
        qdrant_filter = None
        if filter_metadata:
            conditions = [
                FieldCondition(key=k, match=MatchValue(value=v))
                for k, v in filter_metadata.items()
            ]
            qdrant_filter = Filter(must=conditions) if conditions else None

        # Qdrant's sync client + the embedder are blocking; offload so they don't
        # freeze the event loop (and every other request) during a search.
        results = await asyncio.to_thread(
            lambda: client.search(
                collection_name=collection_name,
                query_vector=query_vector,
                limit=top_k,
                query_filter=qdrant_filter,
                with_payload=True,
            )
        )

        return [
            {
                "text": r.payload.get("text", ""),
                "score": r.score,
                "metadata": {k: v for k, v in r.payload.items() if k != "text"},
                "id": str(r.id),
            }
            for r in results
        ]

    except Exception as e:
        logger.warning(f"[RAG] Retrieval failed: {e}")
        return []


async def store(
    text: str,
    metadata: dict,
    collection: str = "knowledge",
    point_id: Optional[str] = None,
) -> str:
    """Store a text chunk with metadata in Qdrant."""
    import uuid
    from qdrant_client.models import PointStruct

    try:
        client = _get_client()
        embedder = get_embedder()

        collection_map = {
            "knowledge": settings.qdrant_knowledge_collection,
            "brand": settings.qdrant_brand_collection,
            "media": settings.qdrant_media_collection,
        }
        collection_name = collection_map.get(collection, settings.qdrant_knowledge_collection)

        vector = (await asyncio.to_thread(embedder.encode, text)).tolist()
        pid = point_id or str(uuid.uuid4())

        payload = {"text": text, **metadata}
        await asyncio.to_thread(
            lambda: client.upsert(
                collection_name=collection_name,
                points=[PointStruct(id=pid, vector=vector, payload=payload)]
            )
        )
        return pid

    except Exception as e:
        logger.error(f"[RAG] Store failed: {e}")
        raise


async def delete_points(
    point_ids: list[str],
    collection: str = "knowledge",
) -> None:
    """Delete specific points from Qdrant by ID."""
    if not point_ids:
        return
    try:
        client = _get_client()
        collection_map = {
            "knowledge": settings.qdrant_knowledge_collection,
            "brand": settings.qdrant_brand_collection,
            "media": settings.qdrant_media_collection,
        }
        collection_name = collection_map.get(collection, settings.qdrant_knowledge_collection)
        await asyncio.to_thread(lambda: client.delete(collection_name=collection_name, points_selector=point_ids))
        logger.info(f"[RAG] Deleted {len(point_ids)} points from {collection_name}")
    except Exception as e:
        logger.error("Failed to delete points from Qdrant: %s", str(e), exc_info=True)


async def ensure_collections():
    """Create Qdrant collections if they don't exist."""
    from qdrant_client.models import Distance, VectorParams
    client = _get_client()
    collections_to_create = [
        settings.qdrant_knowledge_collection,
        settings.qdrant_brand_collection,
        settings.qdrant_media_collection,
    ]
    existing = {c.name for c in (await asyncio.to_thread(client.get_collections)).collections}
    for name in collections_to_create:
        if name not in existing:
            await asyncio.to_thread(
                lambda n=name: client.create_collection(
                    collection_name=n,
                    vectors_config=VectorParams(size=settings.qdrant_dimension, distance=Distance.COSINE),
                )
            )
            logger.info(f"[RAG] Created collection: {name}")
