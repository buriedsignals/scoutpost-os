"""
dependencies package — FastAPI auth dependencies and adapter providers.

Submodules:
  - auth.py      — Supabase JWT user dependency, user response builder
  - providers.py — adapter provider factories
"""
from app.dependencies.auth import (
    build_user_response,
    get_current_user,
)

__all__ = [
    "build_user_response",
    "get_current_user",
]
