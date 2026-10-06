"""Storage port interfaces."""
from abc import ABC, abstractmethod


class UserStoragePort(ABC):
    @abstractmethod
    async def get_user(self, user_id: str) -> dict | None: ...
    @abstractmethod
    async def create_or_update_user(self, user_id: str, data: dict) -> dict: ...
