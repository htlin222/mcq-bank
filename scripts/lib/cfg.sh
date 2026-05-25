# Source me from a bash script in scripts/ to read values from /config.toml.
# The caller is expected to have already `cd`ed to the repo root, which all
# our scripts do via `cd "$(dirname "$0")/.."`.
#
# Usage:
#   . "$(dirname "$0")/lib/cfg.sh"
#   db_name=$(cfg project.d1_db)
#
# Requires python3 (>= 3.11 for stdlib tomllib).

cfg() {
  python3 - "$1" <<'PY'
import sys, tomllib
key = sys.argv[1]
try:
    with open("config.toml", "rb") as f:
        data = tomllib.load(f)
except FileNotFoundError:
    sys.stderr.write(
        "✖ config.toml not found. Run `cp config.example.toml config.toml` "
        "or ./scripts/setup.sh first.\n"
    )
    sys.exit(2)
v = data
for k in key.split("."):
    if not isinstance(v, dict) or k not in v:
        sys.stderr.write(f"✖ config key not found: {key}\n")
        sys.exit(3)
    v = v[k]
print(v, end="")
PY
}
