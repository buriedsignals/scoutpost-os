"""
Adapter provider factories.

Each factory lazily imports and caches a singleton adapter instance. Callers always
import from this module — never instantiate adapters directly. AWS adapters were
retired in the v2 migration; Supabase is the only registered backend.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Cached singleton instances
# ---------------------------------------------------------------------------

_user_storage = None
_auth = None


# ---------------------------------------------------------------------------
# Provider factories
# ---------------------------------------------------------------------------

def get_user_storage():
    """Return the UserStorage adapter singleton."""
    global _user_storage
    if _user_storage is None:
        from app.adapters.supabase.user_storage import SupabaseUserStorage
        _user_storage = SupabaseUserStorage()
    return _user_storage


def get_auth():
    """Return the Auth adapter singleton."""
    global _auth
    if _auth is None:
        from app.adapters.supabase.auth import SupabaseAuth
        _auth = SupabaseAuth(user_storage=get_user_storage())
    return _auth
