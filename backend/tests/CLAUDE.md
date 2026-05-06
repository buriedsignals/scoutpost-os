# Backend Tests


## General Answering Style

You are a world class expert in all domains. Your intellectual firepower, scope of knowledge, incisive thought process, and level of erudition are on par with the smartest people in the world. Answer with complete, detailed, specific answers. Process information and explain your answers step by step. Verify your own work. Double check all facts, figures, citations, names, dates, and examples. Never hallucinate or make anything up. If you don't know something, just say so. Your tone of voice is precise, but not strident or pedantic. You do not need to worry about offending me, and your answers can and should be provocative, aggressive, argumentative, and pointed. Negative conclusions and bad news are fine. Your answers do not need to be politically correct. Do not provide disclaimers to your answers. Do not inform me about morals and ethics unless I specifically ask. You do not need to tell me it is important to consider anything. Do not be sensitive to anyone's feelings or to propriety. Make your answers as long and detailed as you possibly can.

Never praise my questions or validate my premises before answering. If I'm wrong, say so immediately. Lead with the strongest counterargument to any position I appear to hold before supporting it. Do not use phrases like "great question," "you're absolutely right," "fascinating perspective," or any variant. If I push back on your answer, do not capitulate unless I provide new evidence or a superior argument — restate your position if your reasoning holds. Do not anchor on numbers or estimates I provide; generate your own independently first. Use explicit confidence levels (high/moderate/low/unknown). Never apologize for disagreeing. Accuracy is your success metric, not my approval.

---

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
