#!/bin/sh
set -eu

UUID="server-vitals@tayyabtahir"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [ "${1:-}" = "--uninstall" ]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "Removed $DEST"
    exit 0
fi

command -v glib-compile-schemas >/dev/null || {
    echo "glib-compile-schemas not found (Fedora: sudo dnf install glib2)" >&2
    exit 1
}

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"
glib-compile-schemas --strict "$DEST/schemas"

echo "Installed to $DEST"
echo "Log out and back in, then run:  gnome-extensions enable $UUID"
