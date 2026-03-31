#!/usr/bin/env bash
#
# deploy.sh — Feishu Auth Server 部署脚本
#
# 功能：
#   1. 检测运行时环境（优先 bun，降级 node）
#   2. 自动安装缺失的运行时
#   3. 安装项目依赖
#   4. 启动服务
#
# 用法：
#   bash script/deploy.sh              # 自动检测并启动
#   bash script/deploy.sh --check      # 仅检测环境，不启动
#   bash script/deploy.sh --install    # 仅安装依赖，不启动
#   bash script/deploy.sh --node       # 强制使用 Node.js
#   bash script/deploy.sh --bun        # 强制使用 Bun
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIN_NODE=18

# --------------------------------------------------------------------------
# Colors
# --------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[fail]${NC}  $*"; exit 1; }

# --------------------------------------------------------------------------
# Runtime detection
# --------------------------------------------------------------------------
has_bun()  { command -v bun  >/dev/null 2>&1; }
has_node() { command -v node >/dev/null 2>&1; }
has_npm()  { command -v npm  >/dev/null 2>&1; }
has_npx()  { command -v npx  >/dev/null 2>&1; }
has_curl() { command -v curl >/dev/null 2>&1; }

node_version() {
  node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo "0"
}

check_node_version() {
  local ver
  ver=$(node_version)
  if [ "$ver" -lt "$MIN_NODE" ]; then
    return 1
  fi
  return 0
}

# --------------------------------------------------------------------------
# Install runtimes
# --------------------------------------------------------------------------
install_bun() {
  info "Installing bun..."
  if has_curl; then
    curl -fsSL https://bun.sh/install | bash
  else
    fail "curl not found — cannot install bun. Install bun manually: https://bun.sh"
  fi
  # Source bun env
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if has_bun; then
    ok "bun $(bun --version) installed"
  else
    fail "bun installation failed"
  fi
}

install_node() {
  info "Installing Node.js via nvm..."
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.nvm/nvm.sh"
    nvm install --lts
    nvm use --lts
  elif has_curl; then
    info "nvm not found, installing nvm first..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts
  else
    fail "Cannot install Node.js: curl not available. Install Node.js >= $MIN_NODE manually."
  fi
  if has_node && check_node_version; then
    ok "node $(node --version) installed"
  else
    fail "Node.js installation failed"
  fi
}

# --------------------------------------------------------------------------
# Dependency installation
# --------------------------------------------------------------------------
install_deps() {
  cd "$ROOT"

  if has_bun && [ "$FORCE_RUNTIME" != "node" ]; then
    info "Installing dependencies with bun..."
    bun install --production
    ok "Dependencies installed (bun)"
    return
  fi

  if has_npm; then
    info "Installing dependencies with npm..."
    npm install --omit=dev
    ok "Dependencies installed (npm)"
    return
  fi

  fail "No package manager found (bun/npm). Cannot install dependencies."
}

# --------------------------------------------------------------------------
# Environment check
# --------------------------------------------------------------------------
check_env() {
  local missing=0
  for var in ISSUER_URL APP_ID APP_SECRET RSA_PRIVATE_KEY RSA_PUBLIC_KEY; do
    if [ -z "${!var:-}" ]; then
      warn "Missing env: $var"
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    warn "Some required environment variables are missing. Server may not work correctly."
    warn "See README.md for the full list of required variables."
  fi

  # At least one API key should be set
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    warn "Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set. Proxy endpoints will fail."
  fi
}

# --------------------------------------------------------------------------
# Start server
# --------------------------------------------------------------------------
start_server() {
  cd "$ROOT"

  if [ "$FORCE_RUNTIME" = "bun" ] || { has_bun && [ "$FORCE_RUNTIME" != "node" ]; }; then
    info "Starting with bun..."
    exec bun run src/index.ts
  fi

  if has_node && check_node_version; then
    info "Starting with node (tsx)..."
    # Ensure tsx is available
    if has_npx; then
      exec npx --yes tsx src/index.ts
    elif [ -x "$ROOT/node_modules/.bin/tsx" ]; then
      exec "$ROOT/node_modules/.bin/tsx" src/index.ts
    else
      exec node --import tsx src/index.ts
    fi
  fi

  fail "No suitable runtime found. Install bun or node >= $MIN_NODE."
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
FORCE_RUNTIME=""
MODE="run" # run | check | install

while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE="check"; shift ;;
    --install) MODE="install"; shift ;;
    --bun)     FORCE_RUNTIME="bun"; shift ;;
    --node)    FORCE_RUNTIME="node"; shift ;;
    -h|--help)
      echo "Usage: $0 [--check|--install] [--bun|--node]"
      echo ""
      echo "  --check    Check environment only, don't start"
      echo "  --install  Install runtime & deps only, don't start"
      echo "  --bun      Force bun runtime"
      echo "  --node     Force node runtime"
      exit 0
      ;;
    *) fail "Unknown option: $1" ;;
  esac
done

echo ""
echo "========================================="
echo "  Feishu Auth Server — Deploy"
echo "========================================="
echo ""

# Step 1: Check / install runtime
info "Checking runtime environment..."

if [ "$FORCE_RUNTIME" = "bun" ]; then
  if has_bun; then
    ok "bun $(bun --version)"
  else
    install_bun
  fi
elif [ "$FORCE_RUNTIME" = "node" ]; then
  if has_node && check_node_version; then
    ok "node $(node --version)"
  else
    install_node
  fi
else
  # Auto-detect: prefer bun, fallback node
  if has_bun; then
    ok "bun $(bun --version) (detected)"
  elif has_node && check_node_version; then
    ok "node $(node --version) (detected, bun not found)"
    FORCE_RUNTIME="node"
  else
    warn "Neither bun nor node >= $MIN_NODE found."
    info "Attempting to install bun (recommended)..."
    install_bun || {
      warn "bun install failed, trying node..."
      install_node
      FORCE_RUNTIME="node"
    }
  fi
fi

if [ "$MODE" = "check" ]; then
  echo ""
  check_env
  echo ""
  ok "Environment check complete."
  exit 0
fi

# Step 2: Install dependencies
install_deps

if [ "$MODE" = "install" ]; then
  echo ""
  ok "Installation complete."
  exit 0
fi

# Step 3: Check env vars
check_env

# Step 4: Start
echo ""
start_server
