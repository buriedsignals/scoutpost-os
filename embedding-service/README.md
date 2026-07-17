# embedding-service

Private, bearer-authenticated EmbeddingGemma inference for Scoutpost. It runs
the pinned INT8 ONNX conversion of Google's `embeddinggemma-300m` checkpoint
and returns normalized 768-dimensional vectors. Document/query task prefixes
are applied inside the service so every caller uses one model-space contract.

Required runtime configuration:

- `EMBEDDING_SERVICE_TOKEN` — generated internal bearer token.
- `EMBEDDING_MODEL_DIR` — baked into the image as `/models/embeddinggemma`.

`GET /health` is unauthenticated for orchestrator health checks. `POST /embed`
requires the bearer token. This service does not accept images and does not
send document or query content to an external inference API.
