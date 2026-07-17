FROM python:3.12-slim-bookworm AS model

ARG MODEL_REPOSITORY=onnx-community/embeddinggemma-300m-ONNX
ARG MODEL_REVISION=5090578d9565bb06545b4552f76e6bc2c93e4a66

RUN pip install --no-cache-dir huggingface-hub==1.24.0
RUN hf download "${MODEL_REPOSITORY}" \
    config.json added_tokens.json special_tokens_map.json tokenizer.json \
    tokenizer.model tokenizer_config.json onnx/model_quantized.onnx \
    onnx/model_quantized.onnx_data \
    --revision "${MODEL_REVISION}" \
    --local-dir /models/embeddinggemma

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    EMBEDDING_MODEL_DIR=/models/embeddinggemma

WORKDIR /srv
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY --from=model /models/embeddinggemma /models/embeddinggemma
COPY app ./app

RUN useradd --create-home embedder && chown -R embedder:embedder /srv /models
USER embedder
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8080')}/health\")" || exit 1

CMD ["sh", "-c", "uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8080} --workers 1"]
