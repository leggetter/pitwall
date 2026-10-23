#!/bin/sh
# Installs the chrome-headless-shell the app check runs in on macOS (README.md, "Chrome on macOS"):
# one pinned build from Chrome for Testing, its MD5 checked against the one Google's bucket gives,
# unpacked to ~/.cache/pitwall/chrome-headless-shell/<version>/, where the check looks for it when
# CHROME_PATH isn't set. It downloads about 100 MB, and changes nothing else.
#
#   npm run appcheck:install-shell
#
# The version is the newest that was at least 14 days old on 2026-10-23, as the repo's rule for
# dependencies asks. To bump it, pick a build at least 14 days old, and take each platform's MD5
# from its zip's x-goog-hash header: curl -sI <url> | grep x-goog-hash. Then change VERSION here
# and HEADLESS_SHELL_VERSION in chrome.ts together.

set -eu

VERSION=155.0.8059.39
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=mac-arm64; MD5=IRYE1jryfs0aSFRYC3CVJw== ;;
  Darwin-x86_64) PLATFORM=mac-x64; MD5=csOLrNjIkhbc50qLKNGd2w== ;;
  Linux-x86_64) PLATFORM=linux64; MD5=BCeU3QHA1ApziO+HAcq6Qw== ;;
  *) echo "install-headless-shell: no chrome-headless-shell build for $(uname -s) $(uname -m)" >&2; exit 2 ;;
esac

DIR="$HOME/.cache/pitwall/chrome-headless-shell/$VERSION"
BIN="$DIR/chrome-headless-shell-$PLATFORM/chrome-headless-shell"
URL="https://storage.googleapis.com/chrome-for-testing-public/$VERSION/$PLATFORM/chrome-headless-shell-$PLATFORM.zip"

if [ -x "$BIN" ]; then
  echo "chrome-headless-shell $VERSION is already at $BIN"
  exit 0
fi

mkdir -p "$DIR"
ZIP="$DIR/chrome-headless-shell-$PLATFORM.zip.part"
trap 'rm -f "$ZIP"' EXIT
echo "Downloading chrome-headless-shell $VERSION for $PLATFORM from Chrome for Testing..."
curl -fsSL --retry 2 -o "$ZIP" "$URL"

GOT=$(openssl md5 -binary "$ZIP" | base64)
if [ "$GOT" != "$MD5" ]; then
  echo "install-headless-shell: the download's MD5 is $GOT, not $MD5. Nothing was installed." >&2
  exit 1
fi

unzip -q -o "$ZIP" -d "$DIR"
if [ ! -x "$BIN" ]; then
  echo "install-headless-shell: the zip had no $BIN" >&2
  exit 1
fi
echo "Installed $BIN"
echo "npm run appcheck finds it there; CHROME_PATH, when it's set, wins."
