# Backend Tests

## Project-Wide Rules

Read the nearest parent `AGENTS.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## Running Tests

```bash
cd backend

# All unit tests
python -m pytest tests/unit/ -v

# Specific suite
python -m pytest tests/unit/api/ -v
python -m pytest tests/unit/adapters/ -v

# Single file
python -m pytest tests/unit/api/test_spa_static_files.py -v
```

## Structure (post-cutover)

```
tests/unit/
├── adapters/supabase/              # Adapter implementations (port/adapter)
│   ├── test_auth.py                # SupabaseAuth: JWT validation, user lookup
│   ├── test_connection.py          # asyncpg pool wiring
│   ├── test_user_storage.py        # user_preferences read + first-login upsert
│   └── test_utils.py
├── api/                            # HTTP-surface tests
│   ├── test_public_routes.py       # Root/SPA routes, markdown negotiation
│   ├── test_spa_static_files.py    # SPAStaticFiles (SPA-vs-asset semantics)
│   ├── test_email_static_files.py  # EmailStaticFiles allowlist
│   ├── test_error_response_cache_control.py  # no-store on 4xx/5xx
│   ├── test_local_auth.py          # Local MuckRock broker
│   ├── test_muckrock_proxy.py      # Production MuckRock proxy → Supabase EF
│   └── test_public_edge_proxy.py   # Public REST/MCP edge proxy
├── test_config_secret_guard.py
└── test_edge_function_auth_config.py
```

## Conventions

- **Mocking:** Patch at import location (e.g. `app.adapters.supabase.connection.get_settings`, not `app.config.get_settings`)
- **Async tests:** Use `@pytest.mark.asyncio` with `AsyncMock` for async services
- **HTTP mocks:** `AsyncMock` with `side_effect` for sequential HTTP call chains
- **No network calls:** All external services (Supabase, MuckRock, Resend, MapTiler) must be mocked
- **Test naming:** `test_<behavior>` describing expected outcome, not implementation
