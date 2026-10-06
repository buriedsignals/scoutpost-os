"""
dependencies package — FastAPI auth dependency and adapter providers.

Submodules:
  - auth.py      — Supabase JWT user dependency
  - providers.py — adapter provider factories
"""
from app.dependencies.auth import get_current_user

__all__ = [
    "get_current_user",
]
