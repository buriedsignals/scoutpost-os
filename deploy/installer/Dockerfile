FROM node:22-bookworm

ENV DENO_INSTALL=/usr/local
ENV PATH=/usr/local/bin:/usr/local/npm-global/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssl \
    unzip \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && npm install -g supabase \
  && curl -fsSL https://deno.land/install.sh | sh \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY automation/docker-install-entrypoint.sh /usr/local/bin/cojournalist-installer

WORKDIR /workspace
ENTRYPOINT ["cojournalist-installer"]
CMD ["install"]
