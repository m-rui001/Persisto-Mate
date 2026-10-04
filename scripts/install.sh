#!/usr/bin/env bash
# Install Persisto Mate (mate) into a user-level directory and put it on PATH. No sudo needed.
# Usage: curl -fsSL https://raw.githubusercontent.com/m-rui001/Persisto-Mate/main/scripts/install.sh | bash
set -euo pipefail

REPO="m-rui001/Persisto-Mate"

os="$(uname -s)"
arch="$(uname -m)"
case "$arch" in
	x86_64|amd64) arch="x64" ;;
	arm64|aarch64) arch="arm64" ;;
esac
case "$os" in
	Darwin) platform="darwin-${arch}" ;;
	Linux)  platform="linux-${arch}" ;;
	*) echo "Unsupported OS: $os (on Windows use install.ps1 in PowerShell)" >&2; exit 1 ;;
esac
case "$platform" in
	darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;;
	*) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

url="https://github.com/${REPO}/releases/latest/download/mate-${platform}.tar.gz"
install_dir="${MATE_INSTALL_DIR:-$HOME/.local/share/mate}"
bin_dir="${MATE_BIN_DIR:-$HOME/.local/bin}"

echo "Downloading mate for ${platform}..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/mate.tar.gz"

# Replacing files under a running binary is safe on macOS/Linux (the old inode stays
# alive until the process exits), so unlike the Windows installer no process handling
# is needed - re-running this script updates in place.
if [ -d "$install_dir" ]; then
	echo "Updating mate in ${install_dir}..."
else
	echo "Installing mate to ${install_dir}..."
fi
rm -rf "$install_dir"
mkdir -p "$install_dir" "$(dirname "$install_dir")" "$bin_dir"
tar -xzf "$tmp/mate.tar.gz" -C "$tmp"
# Archive layout is mate/<binary + assets>; move its contents into install_dir.
mv "$tmp"/mate/* "$install_dir"/
chmod +x "$install_dir/mate"

# macOS Gatekeeper: binaries downloaded by curl are quarantined.
if [ "$os" = "Darwin" ]; then
	xattr -dr com.apple.quarantine "$install_dir" 2>/dev/null || true
fi

ln -sf "$install_dir/mate" "$bin_dir/mate"
echo "Installed: $("$bin_dir/mate" --version) -> $bin_dir/mate"

case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*)
		echo ""
		echo "$bin_dir is not on your PATH. Add this to your shell profile, then reopen the terminal:"
		echo "  export PATH=\"$bin_dir:\$PATH\""
		;;
esac
