import json
import re
from typing import Dict, Any, List
import redis
from src.core.models import MemoryContext

class SynapticMemoryMesh:
    def __init__(self, redis_client: redis.Redis, neo4j_driver=None):
        self.redis = redis_client
        self.neo4j = neo4j_driver

    def record_turn(self, session_id: str, role: str, content: str):
        key = f"wm:{session_id}"
        turn_data = json.dumps({"role": role, "content": content})
        self.redis.rpush(key, turn_data)
        self.redis.ltrim(key, -10, -1)

    def retrieve_working_memory(self, session_id: str) -> List[Dict[str, str]]:
        key = f"wm:{session_id}"
        items = self.redis.lrange(key, 0, -1)
        return [json.loads(item) for item in items] if items else []

    def retrieve_episodic_context(self, entities: List[str]) -> List[str]:
        if not entities or not self.neo4j:
            return []
        query = """
        MATCH (e:Entity)-[r]->(target)
        WHERE e.name IN $entities
        RETURN e.name + ' ' + type(r) + ' ' + target.name AS fact
        LIMIT 10
        """
        try:
            with self.neo4j.session() as session:
                result = session.run(query, entities=entities)
                return [record["fact"] for record in result]
        except Exception:
            return []

    def assemble_context(self, session_id: str, prompt: str) -> MemoryContext:
        entities = list(set(re.findall(r'\b[A-Z][a-zA-Z0-9_-]+\b', prompt)))
        return MemoryContext(
            session_id=session_id,
            working_memory=self.retrieve_working_memory(session_id),
            episodic_facts=self.retrieve_episodic_context(entities),
            procedural_skills=[
                {"name": "database_query", "description": "Execute structured queries"},
                {"name": "code_analysis", "description": "Static code inspections"}
            ]
        )
