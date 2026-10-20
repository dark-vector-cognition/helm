#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/build-mac-release.sh [--no-notarize]
#
# Builds a Developer ID signed macOS DMG (arm64 by default, set HELM_MAC_ARCH=x64
# for Intel). Notarization uses a notarytool keychain profile named by
# APPLE_KEYCHAIN_PROFILE (default: helm-notary). Create the profile once with
# `xcrun notarytool store-credentials helm-notary`. This script never reads or
# stores credentials. Use --no-notarize only for a local signed test build.

NOTARIZE=1
if [[ "${1:-}" == "--no-notarize" ]]; then
  NOTARIZE=0
elif [[ -n "${1:-}" ]]; then
  echo "Usage: scripts/build-mac-release.sh [--no-notarize]"
  exit 1
fi

ARCH="${HELM_MAC_ARCH:-arm64}"
PROFILE="${APPLE_KEYCHAIN_PROFILE:-helm-notary}"
VERSION=$(node -p "require('./package.json').version")
DMG="dist/helm-${VERSION}-${ARCH}.dmg"
if [[ "$ARCH" == "x64" ]]; then
  APP="dist/mac/HELM.app"
else
  APP="dist/mac-${ARCH}/HELM.app"
fi

# 1. Confirm the notarytool profile exists before a long build
if [[ "$NOTARIZE" == 1 ]]; then
  if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    echo "Error: notarytool keychain profile '$PROFILE' was not found or did not authenticate."
    echo "Create it with: xcrun notarytool store-credentials $PROFILE"
    echo "Or run with --no-notarize for a signed local test build."
    exit 1
  fi
  export APPLE_KEYCHAIN_PROFILE="$PROFILE"
  BUILDER_ARGS=()
else
  unset APPLE_KEYCHAIN_PROFILE
  BUILDER_ARGS=(-c.mac.notarize=false)
fi

# 2. Build, sign and (when enabled) notarize and staple the app
rm -rf dist
npm run build
# npmRebuild is false, and npm test builds better-sqlite3 for Node. Build it for Electron.
npm run rebuild:electron
npx electron-builder --mac dmg "--${ARCH}" ${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"}

# 3. Notarize and staple the DMG itself
if [[ "$NOTARIZE" == 1 ]]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

# 4. Verify
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvv "$APP" 2>&1 | grep -E '^(Authority|TeamIdentifier|Identifier|Runtime Version|Timestamp)'
if [[ "$NOTARIZE" == 1 ]]; then
  spctl -a -vv "$APP"
  spctl -a -vv -t open --context context:primary-signature "$DMG"
else
  echo "Notarization skipped: Gatekeeper will reject this build on other Macs."
fi
shasum -a 256 "$DMG"
