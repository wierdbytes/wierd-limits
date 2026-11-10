#!/bin/sh
# Installs the limits mod into Herdr (~/.config/herdr-app/mods/limits, or $HERDR_APP_HOME).
# Herdr reloads a mod on every saved file: the modules and icons go first, main.js last, so
# the reload that counts sees all of them.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/limits"
mkdir -p "$dest"
for f in "$here"/herdr-mod/*.svg "$here"/herdr-mod/mod.json; do cp "$f" "$dest/"; done
for f in "$here"/herdr-mod/*.js; do [ "$(basename "$f")" = main.js ] || cp "$f" "$dest/"; done
cp "$here/herdr-mod/main.js" "$dest/main.js"
herdr-app check "$dest"
