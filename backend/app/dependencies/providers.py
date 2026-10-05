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

_scout_storage = None
_execution_storage = None
_run_storage = None
_unit_storage = None
_user_storage = None
_auth = None


# ---------------------------------------------------------------------------
# Provider factories
# ---------------------------------------------------------------------------

def get_scout_storage():
    """Return the ScoutStorage adapter singleton."""
    global _scout_storage
    if _scout_storage is None:
        from app.adapters.supabase.scout_storage import SupabaseScoutStorage
        _scout_storage = SupabaseScoutStorage()
    return _scout_storage


def get_execution_storage():
    """Return the ExecutionStorage adapter singleton."""
    global _execution_storage
    if _execution_storage is None:
        from app.adapters.supabase.execution_storage import SupabaseExecutionStorage
        _execution_storage = SupabaseExecutionStorage()
    return _execution_storage


def get_run_storage():
    """Return the RunStorage adapter singleton."""
    global _run_storage
    if _run_storage is None:
        from app.adapters.supabase.run_storage import SupabaseRunStorage
        _run_storage = SupabaseRunStorage()
    return _run_storage


def get_unit_storage():
    """Return the UnitStorage adapter singleton."""
    global _unit_storage
    if _unit_storage is None:
        from app.adapters.supabase.unit_storage import SupabaseUnitStorage
        _unit_storage = SupabaseUnitStorage()
    return _unit_storage


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
