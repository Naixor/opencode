#!/usr/bin/env bash
#
# Integration test: Config manipulation attacks
# Tests malformed config, missing config, and nested config override via CLI
# Output format: TAP (Test Anything Protocol)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CASES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$CASES_DIR/fixtures"
OPENCODE_DIR="$(cd "$CASES_DIR/../../.." && pwd)"

TEMP_DIR=""
PASS_COUNT=0
FAIL_COUNT=0
TOTAL=10

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

setup_temp() {
  TEMP_DIR="$(mktemp -d)"
  mkdir -p "$TEMP_DIR/.git"
}

echo "TAP version 13"
echo "1..$TOTAL"

# Helper: run a bun script via stdin pipe
# Usage: run_bun_script <<'SCRIPT' ... SCRIPT
run_bun_script() {
  cd "$OPENCODE_DIR" && bun run - 2>&1
}

# ============================================================================
# TEST 1: Valid config loads successfully
# ============================================================================
setup_temp
cp "$FIXTURES_DIR/base-security-config.json" "$TEMP_DIR/.opencode-security.json"

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
const cfg = SecurityConfig.getSecurityConfig();
console.log(JSON.stringify({ rules: cfg.rules?.length ?? 0, roles: cfg.roles?.length ?? 0 }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"rules":3'; then
  echo "ok 1 - Valid config loads with correct rule count"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 1 - Valid config loads with correct rule count"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  expected: rules:3"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 2: Malformed JSON config causes fail-open (empty config)
# ============================================================================
setup_temp
echo '{ "version": "1.0", "rules": [{ broken json' > "$TEMP_DIR/.opencode-security.json"

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
const cfg = SecurityConfig.getSecurityConfig();
const ruleCount = cfg.rules?.length ?? 0;
console.log(JSON.stringify({ ruleCount, failOpen: ruleCount === 0 }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"failOpen":true'; then
  echo "ok 2 - Malformed JSON causes fail-open (no rules applied)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 2 - Malformed JSON causes fail-open (no rules applied)"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 3: Truncated config causes fail-open
# ============================================================================
setup_temp
echo '{ "version": "1.0", "rul' > "$TEMP_DIR/.opencode-security.json"

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
const cfg = SecurityConfig.getSecurityConfig();
const ruleCount = cfg.rules?.length ?? 0;
console.log(JSON.stringify({ ruleCount, failOpen: ruleCount === 0 }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"failOpen":true'; then
  echo "ok 3 - Truncated config causes fail-open"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 3 - Truncated config causes fail-open"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 4: Missing config file causes fail-open (no crash)
# ============================================================================
setup_temp
# No .opencode-security.json created

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
const cfg = SecurityConfig.getSecurityConfig();
const ruleCount = cfg.rules?.length ?? 0;
console.log(JSON.stringify({ ruleCount, failOpen: ruleCount === 0 }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"failOpen":true'; then
  echo "ok 4 - Missing config file causes fail-open (no crash)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 4 - Missing config file causes fail-open (no crash)"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 5: Config with empty rules array means no protection
# ============================================================================
setup_temp
cat > "$TEMP_DIR/.opencode-security.json" << 'JSONEOF'
{
  "version": "1.0",
  "roles": [{"name": "viewer", "level": 10}],
  "rules": []
}
JSONEOF

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
import { SecurityAccess } from "@/security/access";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer");
console.log(JSON.stringify({ allowed: result.allowed }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"allowed":true'; then
  echo "ok 5 - Empty rules array means no protection (all access allowed)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 5 - Empty rules array means no protection (all access allowed)"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 6: Config deletion after load — cached config continues to protect
# ============================================================================
setup_temp
cp "$FIXTURES_DIR/base-security-config.json" "$TEMP_DIR/.opencode-security.json"

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
import { SecurityAccess } from "@/security/access";
import fs from "fs";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
fs.unlinkSync(dir + "/.opencode-security.json");
const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer");
console.log(JSON.stringify({ allowed: result.allowed, cachedProtection: !result.allowed }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"cachedProtection":true'; then
  echo "ok 6 - Config deletion after load does not remove protection (cache persists)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 6 - Config deletion after load does not remove protection (cache persists)"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 7: Nested config merge — child cannot remove parent restrictions
# ============================================================================
setup_temp
cat > "$TEMP_DIR/.opencode-security.json" << 'JSONEOF'
{
  "version": "1.0",
  "roles": [{"name": "admin", "level": 100}, {"name": "viewer", "level": 10}],
  "rules": [
    {
      "pattern": "secrets/**",
      "type": "directory",
      "deniedOperations": ["read", "write"],
      "allowedRoles": ["admin"]
    }
  ]
}
JSONEOF

mkdir -p "$TEMP_DIR/child"
cat > "$TEMP_DIR/child/.opencode-security.json" << 'JSONEOF'
{
  "version": "1.0",
  "roles": [{"name": "admin", "level": 100}, {"name": "viewer", "level": 10}],
  "rules": [
    {
      "pattern": "secrets/public/**",
      "type": "directory",
      "deniedOperations": [],
      "allowedRoles": ["viewer"]
    }
  ]
}
JSONEOF

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
import { SecurityAccess } from "@/security/access";
import fs from "fs";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
const parentCfg = SecurityConfig.getSecurityConfig();
const childCfgRaw = JSON.parse(fs.readFileSync(dir + "/child/.opencode-security.json", "utf8"));
const merged = SecurityConfig.mergeSecurityConfigs([parentCfg, childCfgRaw]);
SecurityConfig.resetConfig();
fs.writeFileSync(dir + "/.opencode-security.json", JSON.stringify(merged, null, 2));
await SecurityConfig.loadSecurityConfig(dir);
const result = SecurityAccess.checkAccess("secrets/public/data.txt", "read", "viewer");
console.log(JSON.stringify({ allowed: result.allowed, parentWins: !result.allowed }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"parentWins":true'; then
  echo "ok 7 - Child config cannot remove parent restrictions (parent wins)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 7 - Child config cannot remove parent restrictions (parent wins)"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 8: Conflicting role definitions across configs throws error
# ============================================================================
setup_temp

RESULT=$(run_bun_script <<'SCRIPT'
import { SecurityConfig } from "@/security/config";
const configA = {
  version: "1.0",
  roles: [{ name: "admin", level: 100 }],
  rules: []
};
const configB = {
  version: "1.0",
  roles: [{ name: "admin", level: 50 }],
  rules: []
};
try {
  SecurityConfig.mergeSecurityConfigs([configA, configB]);
  console.log(JSON.stringify({ threw: false }));
} catch (e) {
  console.log(JSON.stringify({ threw: true, message: e.message }));
}
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"threw":true'; then
  echo "ok 8 - Conflicting role definitions across configs throws error"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 8 - Conflicting role definitions across configs throws error"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 9: Config with 1000+ rules does not crash or timeout
# ============================================================================
setup_temp

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
import { SecurityAccess } from "@/security/access";
import fs from "fs";
const rules = [];
for (let i = 0; i < 1000; i++) {
  rules.push({
    pattern: "protected-dir-" + i + "/**",
    type: "directory",
    deniedOperations: ["read"],
    allowedRoles: ["admin"]
  });
}
const config = {
  version: "1.0",
  roles: [{ name: "admin", level: 100 }, { name: "viewer", level: 10 }],
  rules
};
const dir = "${TEMP_DIR}";
fs.writeFileSync(dir + "/.opencode-security.json", JSON.stringify(config));
const start = Date.now();
await SecurityConfig.loadSecurityConfig(dir);
const result = SecurityAccess.checkAccess("protected-dir-500/test.txt", "read", "viewer");
const elapsed = Date.now() - start;
console.log(JSON.stringify({ elapsed, blocked: !result.allowed, under5s: elapsed < 5000 }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"under5s":true'; then
  echo "ok 9 - Config with 1000+ rules loads and checks in under 5 seconds"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 9 - Config with 1000+ rules loads and checks in under 5 seconds"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# TEST 10: Schema-invalid config causes fail-open
# ============================================================================
setup_temp
cat > "$TEMP_DIR/.opencode-security.json" << 'JSONEOF'
{
  "version": "1.0",
  "rules": [
    {
      "pattern": "secrets/**",
      "type": "INVALID_TYPE",
      "deniedOperations": ["read"],
      "allowedRoles": ["admin"]
    }
  ]
}
JSONEOF

RESULT=$(run_bun_script <<SCRIPT
import { SecurityConfig } from "@/security/config";
import { SecurityAccess } from "@/security/access";
const dir = "${TEMP_DIR}";
await SecurityConfig.loadSecurityConfig(dir);
const cfg = SecurityConfig.getSecurityConfig();
const ruleCount = cfg.rules?.length ?? 0;
const result = SecurityAccess.checkAccess("secrets/key.pem", "read", "viewer");
console.log(JSON.stringify({ ruleCount, allowed: result.allowed, failOpen: result.allowed }));
SecurityConfig.resetConfig();
SCRIPT
) || true

if echo "$RESULT" | grep -q '"failOpen":true'; then
  echo "ok 10 - Schema-invalid config causes fail-open"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "not ok 10 - Schema-invalid config causes fail-open"
  echo "  ---"
  echo "  output: $RESULT"
  echo "  ---"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
cleanup

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "# Config Manipulation Integration Tests"
echo "# Passed: $PASS_COUNT / $TOTAL"
echo "# Failed: $FAIL_COUNT / $TOTAL"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
