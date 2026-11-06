# Sandbox image for autofix-agent.
# git, Node 20 (+ pnpm/yarn via corepack), Python 3.11 + uv, Go, ripgrep, non-root user.
# No secrets are baked in or mounted; the container is disconnected from the
# network after dependencies are installed.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential ripgrep \
      software-properties-common gnupg jq unzip xz-utils \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3.11 python3.11-venv python3.11-dev \
 && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 \
 && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
 && rm -rf /var/lib/apt/lists/*

# Node 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && corepack enable \
 && rm -rf /var/lib/apt/lists/*

# Go 1.22
ARG GO_VERSION=1.22.10
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" -o /tmp/go.tgz \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz

# uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Non-root user that owns the workspace
RUN useradd -m -u 1000 -s /bin/bash agent \
 && mkdir -p /workspace \
 && chown agent:agent /workspace

ENV PATH=/home/agent/.local/bin:/usr/local/go/bin:/home/agent/go/bin:/usr/local/bin:/usr/bin:/bin \
    GOPATH=/home/agent/go \
    GOFLAGS=-mod=mod \
    UV_LINK_MODE=copy \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    CI=true

USER agent
WORKDIR /workspace

# Keep the container alive; the host drives it with `docker exec`.
CMD ["sleep", "infinity"]
