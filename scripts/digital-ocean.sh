#!/usr/bin/env bash

# Provision an Ubuntu ultrapeer with synthetic shares for load testing.

set -euo pipefail

SCRIPT_DIR="$(
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
)"
if [[ -f "$SCRIPT_DIR/bin/gnutonium.ts" ]]; then
  REPO_ROOT="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/../bin/gnutonium.ts" ]]; then
  REPO_ROOT="$(
    CDPATH= cd -- "$SCRIPT_DIR/.." && pwd
  )"
else
  echo "error: expected scripts/digital-ocean.sh inside the repo or next to bin/gnutonium.ts" >&2
  exit 1
fi
cd "$REPO_ROOT"

LISTEN_PORT="${LISTEN_PORT:-6346}"
if [[ ! "$LISTEN_PORT" =~ ^[0-9]{1,5}$ ]] || ((10#$LISTEN_PORT < 1024 || 10#$LISTEN_PORT > 65535)); then
  echo "error: LISTEN_PORT must be between 1024 and 65535 for the unprivileged client" >&2
  exit 1
fi
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
BUN_BIN="$BUN_INSTALL/bin/bun"

if command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
  SUDO=(sudo)
else
  SUDO=()
fi

resolve_public_ip() {
  local ip

  if [[ -n "${PUBLIC_IP:-}" ]]; then
    printf '%s\n' "$PUBLIC_IP"
    return 0
  fi

  ip="$(
    curl -fsS --connect-timeout 2 --max-time 5 \
      http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address \
      2>/dev/null || true
  )"
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
    return 0
  fi

  ip="$(
    curl -fsS --connect-timeout 5 --max-time 10 \
      https://api.ipify.org 2>/dev/null || true
  )"
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
    return 0
  fi

  echo "error: unable to determine public IP; set PUBLIC_IP and rerun" >&2
  exit 1
}

echo "==> Installing apt packages"
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y curl ca-certificates unzip zip passwd util-linux

if [[ ! -x "$BUN_BIN" ]]; then
  echo "==> Installing Bun"
  curl -fsSL https://bun.sh/install | bash
fi

export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$PATH"

RUN_AS=()
if [[ "$(id -u)" -eq 0 ]]; then
  # Keep code root-owned and put writable runtime state under a service account.
  RUN_USER="${GNUTONIUM_USER:-gnutonium}"
  STATE_DIR="${GNUTONIUM_STATE_DIR:-/var/lib/gnutonium}"
  RUNTIME_ROOT="${GNUTONIUM_RUNTIME_ROOT:-/opt/gnutonium}"
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$RUN_USER"
  fi
  if [[ "$(id -u "$RUN_USER")" -eq 0 ]]; then
    echo "error: GNUTONIUM_USER must be an unprivileged account" >&2
    exit 1
  fi
  install -d -m 0755 "$RUNTIME_ROOT" "$RUNTIME_ROOT/scripts"
  if [[ "$REPO_ROOT" != "$RUNTIME_ROOT" ]]; then
    cp -R "$REPO_ROOT/bin" "$REPO_ROOT/src" "$RUNTIME_ROOT/"
    install -m 0644 "$REPO_ROOT/scripts/generate-random-base32-file.ts" "$RUNTIME_ROOT/scripts/"
  fi
  chmod -R a+rX,go-w "$RUNTIME_ROOT/bin" "$RUNTIME_ROOT/src" "$RUNTIME_ROOT/scripts"
  if [[ "$BUN_BIN" != "$RUNTIME_ROOT/bun" ]]; then
    install -m 0755 "$BUN_BIN" "$RUNTIME_ROOT/bun"
  fi
  install -d -m 0750 -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$STATE_DIR"
  CONFIG_PATH="${CONFIG_PATH:-$STATE_DIR/gnutella.json}"
  REPO_ROOT="$RUNTIME_ROOT"
  BUN_BIN="$RUNTIME_ROOT/bun"
  RUN_AS=(runuser -u "$RUN_USER" --)
else
  CONFIG_PATH="${CONFIG_PATH:-gnutella.json}"
fi
cd "$REPO_ROOT"

PUBLIC_IP="$(resolve_public_ip)"
echo "==> Using public IP $PUBLIC_IP and port $LISTEN_PORT"

echo "==> Initializing config at $CONFIG_PATH"
"${RUN_AS[@]}" "$BUN_BIN" run bin/gnutonium.ts init --config "$CONFIG_PATH"

echo "==> Updating config"
CONFIG_PATH_ENV="$CONFIG_PATH" \
PUBLIC_IP_ENV="$PUBLIC_IP" \
LISTEN_PORT_ENV="$LISTEN_PORT" \
  "${RUN_AS[@]}" "$BUN_BIN" -e '
    import fs from "node:fs";

    const configPath = process.env.CONFIG_PATH_ENV;
    const publicIp = process.env.PUBLIC_IP_ENV;
    const listenPort = Number(process.env.LISTEN_PORT_ENV);

    if (!configPath) throw new Error("CONFIG_PATH_ENV is required");
    if (!publicIp) throw new Error("PUBLIC_IP_ENV is required");
    if (!Number.isInteger(listenPort) || listenPort <= 0) {
      throw new Error(`invalid LISTEN_PORT_ENV: ${process.env.LISTEN_PORT_ENV}`);
    }

    const doc = JSON.parse(fs.readFileSync(configPath, "utf8"));
    doc.config ??= {};
    doc.state ??= {};

    doc.config.listen_ip = "0.0.0.0";
    doc.config.listen_port = listenPort;
    doc.config.advertised_ip = publicIp;
    doc.config.advertised_port = listenPort;
    doc.config.ultrapeer = true;

    fs.writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  '

DOWNLOADS_DIR="$(
  CONFIG_PATH_ENV="$CONFIG_PATH" \
    "${RUN_AS[@]}" "$BUN_BIN" -e '
      import fs from "node:fs";
      import path from "node:path";

      const configPath = process.env.CONFIG_PATH_ENV;
      if (!configPath) throw new Error("CONFIG_PATH_ENV is required");

      const doc = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const configDir = path.dirname(path.resolve(configPath));
      const dataDirValue =
        typeof doc?.config?.data_dir === "string" ? doc.config.data_dir.trim() : "";
      const dataDir = dataDirValue
        ? path.isAbsolute(dataDirValue)
          ? path.normalize(dataDirValue)
          : path.resolve(configDir, dataDirValue)
        : configDir;

      console.log(path.join(dataDir, "downloads"));
    '
)"

echo "==> Generating 10 random files in $DOWNLOADS_DIR"
for ((i = 0; i < 10; i++)); do
  "${RUN_AS[@]}" "$BUN_BIN" run scripts/generate-random-base32-file.ts --dir "$DOWNLOADS_DIR"
done

echo "==> Starting Gnutonium"
echo "note: allow inbound TCP ${LISTEN_PORT} in DigitalOcean and any local firewall"
exec "${RUN_AS[@]}" "$BUN_BIN" run bin/gnutonium.ts run --config "$CONFIG_PATH"
