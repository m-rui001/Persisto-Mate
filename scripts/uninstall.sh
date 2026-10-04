#!/usr/bin/env bash
# Uninstall Persisto Mate: remove the install directory and the ~/.local/bin link.
# Usage: curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/uninstall.sh | bash
# The companion's state and memories in ~/.mate are KEPT - delete that directory
# yourself if you want them gone too.
set -euo pipefail

install_dir="${MATE_INSTALL_DIR:-$HOME/.local/share/mate}"
bin_dir="${MATE_BIN_DIR:-$HOME/.local/bin}"

if [ -e "$bin_dir/mate" ] || [ -L "$bin_dir/mate" ]; then
	rm -f "$bin_dir/mate"
	echo "Removed $bin_dir/mate"
fi

if [ -d "$install_dir" ]; then
	rm -rf "$install_dir"
	echo "Removed $install_dir"
else
	echo "Nothing to remove at $install_dir"
fi

echo "mate uninstalled. Companion state in ~/.mate was kept; remove that directory too if you want everything gone."
if [ -n "${MATE_BIN_DIR:-}" ]; then
	echo "(If you added an export PATH line for $bin_dir to your shell profile, remove it by hand.)"
fi
