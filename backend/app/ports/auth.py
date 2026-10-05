"""Auth port interface."""
from abc import ABC, abstractmethod
from fastapi import Request


class AuthPort(ABC):
    @abstractmethod
    async def get_current_user(self, request: Request) -> dict: ...
