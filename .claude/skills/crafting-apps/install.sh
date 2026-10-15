#!/usr/bin/env bash
# Install (or update) ArtCraft Crafting Apps from their latest GitHub release, Linux only.
# Verifies every download against the release's SHA256SUMS.txt before extracting.
# Usage: install.sh [app ...]   (default: all seven)
# Installs to ~/.local/opt/<app>-<ver>-linux-<arch>/ and links bin/* into ~/.local/bin/.
set -euo pipefail

ALL=(photocraft filmcraft effectcraft vectorcraft lightcraft pdfcraft designcraft)
apps=("$@"); [ ${#apps[@]} -eq 0 ] && apps=("${ALL[@]}")

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=x86_64 ;;
  Linux-aarch64|Linux-arm64) arch=aarch64 ;;
  *) echo "Unsupported platform $(uname -sm): install from the release page by hand (see SKILL.md)." >&2; exit 2 ;;
esac

opt="$HOME/.local/opt"; bin="$HOME/.local/bin"; mkdir -p "$opt" "$bin"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

for app in "${apps[@]}"; do
  [ "$app" = printcraft ] && app=pdfcraft   # PrintCraft is PdfCraft's former name
  case " ${ALL[*]} " in *" $app "*) ;; *) echo "unknown app: $app" >&2; exit 2 ;; esac
  base="https://github.com/storytold/$app/releases/latest/download"
  mkdir -p "$tmp/$app"
  curl -fsSL -o "$tmp/$app/SHA256SUMS.txt" "$base/SHA256SUMS.txt"
  file="$(grep -oE "${app}-[0-9][0-9.]*-linux-${arch}\.tar\.gz" "$tmp/$app/SHA256SUMS.txt" | head -1)"
  [ -n "$file" ] || { echo "$app: no linux-$arch tarball in latest release" >&2; exit 1; }
  dir="${file%.tar.gz}"
  if [ -x "$opt/$dir/bin/$app-cli" ]; then echo "$app: $dir already installed"; else
    curl -fsSL -o "$tmp/$app/$file" "$base/$file"
    (cd "$tmp/$app" && sha256sum -c --ignore-missing --strict SHA256SUMS.txt) \
      || { echo "$app: CHECKSUM MISMATCH, not installed" >&2; exit 1; }
    tar xzf "$tmp/$app/$file" -C "$opt"
    echo "$app: installed $dir (checksum OK)"
  fi
  ln -sf "$opt/$dir"/bin/* "$bin/"
done
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to PATH: export PATH=\"$bin:\$PATH\"" ;; esac
