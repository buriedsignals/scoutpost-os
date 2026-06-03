# Backend Tests

## Project-Wide Rules

Read the nearest parent `CLAUDE.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## Running Tests

```bash
cd backend

# All unit tests
python -m pytest tests/unit/ -v

# Specific suite
python -m pytest tests/unit/api/ -v
python -m pytest tests/unit/adapters/ -v
python -m pytest tests/unit/shared/ -v

# Single file
python -m pytest tests/unit/api/test_spa_static_files.py -v
```

## Structure (post-cutover)

```
tests/unit/
├── adapters/supabase/              # Adapter implementations (port/adapter)
│   ├── test_auth.py                # SupabaseAuth: JWT validation, user lookup
│   ├── test_billing.py             # Billing no-op adapter
│   ├── test_connection.py          # asyncpg pool wiring
│   ├── test_execution_storage.py   # Execution records (pgvector embeddings)
│   ├── test_run_storage.py, ...    # Other surviving ports
│   └── test_utils.py
├── api/                            # HTTP-surface tests
│   ├── test_v1_endpoints.py        # External API (cj_ key auth)
│   ├── test_public_routes.py       # Root/SPA routes, markdown negotiation
│   ├── test_spa_static_files.py    # SPAStaticFiles (SPA-vs-asset semantics)
│   ├── test_email_static_files.py  # EmailStaticFiles allowlist
│   ├── test_error_response_cache_control.py  # no-store on 4xx/5xx
│   ├── test_local_auth.py          # Local MuckRock broker
│   ├── test_muckrock_proxy.py      # Production MuckRock proxy → Supabase EF
│   ├── test_public_edge_proxy.py   # Public REST/MCP edge proxy
│   ├── test_license_key.py         # License-key gating
│   ├── test_api_key_service.py     # cj_ API key validation
│   └── test_schedule_service.py    # Scout CRUD / schedule translation
├── auth/                           # Session/user services
│   ├── test_session_service.py
│   └── test_user_service.py
├── ports/                          # Port contract compliance
│   └── test_port_contracts.py
├── shared/                         # Cross-cutting infrastructure
│   ├── test_cron.py                # Cron expression builder
│   ├── test_credits.py             # Credit accounting helpers
│   ├── test_embedding_utils.py     # Embedding compression, cosine similarity
│   ├── test_feed_search.py         # Feed search service
│   ├── test_cms_export.py          # CMS URL validation, SSRF, token handling
│   └── test_timezone.py
├── test_edge_function_auth_config.py
└── test_onboarding_tour.py
```

## Conventions

- **Mocking:** Patch at import location (e.g. `app.services.schedule_service.<x>`, not `app.utils.<x>`)
- **Async tests:** Use `@pytest.mark.asyncio` with `AsyncMock` for async services
- **HTTP mocks:** `AsyncMock` with `side_effect` for sequential HTTP call chains
- **No network calls:** All external services (Supabase, MuckRock, Resend, MapTiler) must be mocked
- **Test naming:** `test_<behavior>` describing expected outcome, not implementation

## Key Mock Patterns

### HTTP client (when a service delegates to `get_http_client()`)

```python
mock_client = AsyncMock()
mock_client.post = AsyncMock(side_effect=[response_a, response_b])
mock_get_client = AsyncMock(return_value=mock_client)
```
