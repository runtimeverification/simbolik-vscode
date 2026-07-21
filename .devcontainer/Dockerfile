FROM node:22-bookworm

# --- System packages -------------------------------------------------------
# git/sudo/less: base dev convenience. libdbus-1-3: required by the Stellar CLI.
# build-essential/clang/pkg-config/libssl: needed to compile Rust contracts and
# any from-source crates. curl/xz/jq: used by the toolchain installers below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    sudo \
    ca-certificates \
    less \
    curl \
    xz-utils \
    jq \
    build-essential \
    clang \
    pkg-config \
    libssl-dev \
    libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# Give the default `node` user passwordless sudo (convenient inside the container)
RUN echo "node ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

# Bootstrap Claude Code via npm so the `claude` CLI exists, then switch to the
# native installer as the node user. The native install lives under ~/.local/bin,
# which node owns, so auto-updates work without sudo or a writable npm prefix.
RUN npm install -g @anthropic-ai/claude-code

# --- GitHub CLI (prebuilt) -------------------------------------------------
# Used by `scripts/dev.sh pr` to open coordinated PRs across the semantics chain.
ARG GH_CLI_VERSION=2.63.2
RUN curl -sSL \
      "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz" \
    | tar xz -C /usr/local --strip-components=1 \
        "gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" \
  && gh --version

# --- Nix prep --------------------------------------------------------------
# Single-user Nix is installed under /nix as the `node` user (no systemd in the
# container). Pre-create /nix with node ownership so the installer can write it.
RUN mkdir -p /nix && chown -R node /nix

USER node
WORKDIR /workspace

RUN claude install

# --- Nix + kup + komet-node ------------------------------------------------
# komet-node executes contracts via the K-based `komet` semantics. Both the
# node and its semantics are now published to RV's binary cache, so we install
# the whole thing with a single `kup install komet-node` — pulling prebuilt
# binaries instead of compiling the semantics from source (the old approach
# required uv + a Python venv + a multi-minute `kdist build`).
ENV NIX_CONFIG="experimental-features = nix-command flakes"
RUN curl -L https://nixos.org/nix/install | sh -s -- --no-daemon --yes
ENV PATH="/home/node/.nix-profile/bin:/home/node/.local/bin:/home/node/.cargo/bin:${PATH}"
# Mark `node` as a trusted Nix user and pre-register RV's binary caches. kup
# otherwise prompts interactively to add these substituters, and the build dies
# with EOFError on input() since stdin is closed. When the user is trusted, kup
# skips the prompt and passes the caches as flags instead. Keys are kup's own.
RUN sudo mkdir -p /etc/nix \
  && printf '%s\n' \
      'trusted-users = root node' \
      'extra-substituters = https://k-framework.cachix.org https://k-framework-binary.cachix.org' \
      'extra-trusted-public-keys = k-framework.cachix.org-1:jeyMXB2h28gpNRjuVkehg+zLj62ma1RnyyopA/20yFE= k-framework-binary.cachix.org-1:pJedQ8iG19BW3v/DMMmiRVtwRBGO3fyMv2Ws0OpBADs=' \
    | sudo tee -a /etc/nix/nix.conf
RUN curl -L https://kframework.org/install | bash
