"""Storage port interfaces."""
from abc import ABC, abstractmethod


class ScoutStoragePort(ABC):
    @abstractmethod
    async def list_scouts(self, user_id: str) -> list[dict]: ...


class ExecutionStoragePort(ABC):
    @abstractmethod
    async def get_recent_executions(self, user_id: str, scout_id: str,
                                     limit: int = 5) -> list[dict]: ...


class RunStoragePort(ABC):
    @abstractmethod
    async def get_latest_runs(self, user_id: str, limit: int = 10) -> list[dict]: ...


class UnitStoragePort(ABC):
    @abstractmethod
    async def search_units(self, user_id: str, query_embedding: list[float],
                            filters: dict = None, limit: int = 20) -> list[dict]: ...
    @abstractmethod
    async def get_units_for_article(self, article_id: str) -> list[dict]: ...
    @abstractmethod
    async def get_units_by_location(self, user_id: str, country: str,
                                     state: str = None, city: str = None,
                                     limit: int = 50) -> list[dict]: ...
    @abstractmethod
    async def get_units_by_topic(self, user_id: str, topic: str,
                                  limit: int = 50) -> list[dict]: ...
    @abstractmethod
    async def get_distinct_locations(self, user_id: str) -> list[dict]: ...
    @abstractmethod
    async def get_distinct_topics(self, user_id: str) -> list[str]: ...
    @abstractmethod
    async def mark_used(self, unit_keys: list[tuple[str, str]]) -> None: ...
    @abstractmethod
    async def get_all_unused_units(self, user_id: str, limit: int = 50) -> list[dict]: ...


class UserStoragePort(ABC):
    @abstractmethod
    async def get_user(self, user_id: str) -> dict | None: ...
    @abstractmethod
    async def create_or_update_user(self, user_id: str, data: dict) -> dict: ...
    @abstractmethod
    async def update_profile(self, user_id: str, updates: dict) -> None: ...
