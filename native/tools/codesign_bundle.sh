#!/bin/bash
# codesign_bundle.sh — sign an FFGL .bundle with a specified identity.
#
# Usage:
#   codesign_bundle.sh <identity> <bundle_path>
#
# `<identity>` is "-" for ad-hoc, or the common-name (CN) of a code-
# signing certificate in the current user's keychain. The named-cert
# path is verified before we sign — failing the build is preferable
# to silently falling back to ad-hoc, which has no stable identity
# (end-users would have to re-approve through Gatekeeper on every
# release).
#
# After signing, the script verifies the bundle's signature and
# echoes the expected Authority so the build log shows the cert in
# use.
set -e

IDENTITY="$1"
BUNDLE="$2"

if [ -z "$IDENTITY" ] || [ -z "$BUNDLE" ]; then
  echo "Usage: $0 <identity|-> <bundle_path>" >&2
  exit 1
fi

if [ ! -d "$BUNDLE" ]; then
  echo "ERROR: bundle not found at $BUNDLE" >&2
  exit 1
fi

# Validate that the named identity is in the current keychain before
# trying to sign. `security find-identity -p codesigning -v` lists
# valid code-signing certs; if the name isn't there, codesign would
# silently fall back to ad-hoc with a warning that's easy to miss in
# a busy build log.
if [ "$IDENTITY" != "-" ]; then
  if ! security find-identity -p codesigning -v 2>/dev/null \
       | grep -q -- "\"$IDENTITY\""; then
    echo "ERROR: code-signing identity '$IDENTITY' not found in keychain." >&2
    echo "" >&2
    echo "Available code-signing identities:" >&2
    security find-identity -p codesigning -v >&2 || true
    echo "" >&2
    echo "To create a self-signed cert: Keychain Access → Certificate" >&2
    echo "Assistant → Create a Certificate. Name = '$IDENTITY',"     >&2
    echo "Identity Type = Self Signed Root, Certificate Type = Code Signing." >&2
    echo "Then reconfigure CMake with:" >&2
    echo "  cmake -DSTREAKYBLOBS_CODESIGN_IDENTITY=\"$IDENTITY\" .." >&2
    exit 1
  fi
fi

echo "[codesign] signing $BUNDLE as '$IDENTITY'"
codesign --force --deep --sign "$IDENTITY" "$BUNDLE"

# Echo the resulting signature info so the build log surfaces it. If
# this differs from the requested identity, something went wrong.
echo "[codesign] verifying signature:"
codesign -dvv "$BUNDLE" 2>&1 | grep -E '^(Authority|Signature|TeamIdentifier|Identifier)=' || true
