#!/bin/bash
set -euo pipefail

# Deploy the RUM SDK CDN files.
# Usage: ./deploy.sh [distribution-id]
#
# Requires the siteqwality AWS profile and a build (npm run build). Uploads every file in
# dist/cdn/ (the core, its versioned replay chunk and the chunk's gzip fallback) to:
#   rum/v<version>/  pinned and immutable (customers may pin it, with Subresource Integrity)
#   rum/v<major>/    the latest release of that major line (rum/v2/ for 2.x)
# Another major line's prefix is never written, so a 2.x deploy leaves rum/v1/ on 1.x.
# rum/config/ belongs to the api's config publisher and is never touched here.

SDK_BUCKET="sq-prod-us-east-1-rum-sdk"
DIST_DIR="dist/cdn"
CDN_DISTRIBUTION_ID="${1:-}"
VERSION="$(node -p "require('./package.json').version")"
MAJOR="${VERSION%%.*}"
PINNED_PREFIX="rum/v${VERSION}"
MAJOR_PREFIX="rum/v${MAJOR}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: refusing to deploy pre-release version ${VERSION}."
  exit 1
fi

if [ ! -f "$DIST_DIR/sdk.min.js" ] || [ ! -f "$DIST_DIR/recorder-${VERSION}.min.js" ] || [ ! -f "$DIST_DIR/gzip-${VERSION}.min.js" ]; then
  echo "Error: $DIST_DIR has no ${VERSION} build. Run 'npm run build' first."
  exit 1
fi

if ! grep -q "VERSION = '${VERSION}'" src/version.ts; then
  echo "Error: src/version.ts does not match package.json ${VERSION}."
  exit 1
fi

if aws s3 ls "s3://${SDK_BUCKET}/${PINNED_PREFIX}/sdk.min.js" --profile siteqwality >/dev/null 2>&1; then
  echo "Error: ${PINNED_PREFIX}/ is already published and is immutable. Bump the version in package.json."
  exit 1
fi

# No --delete: cached cores keep loading the replay chunk of their own version.
upload() {
  local prefix="$1" js_cache="$2"
  echo "Uploading SDK files to s3://${SDK_BUCKET}/${prefix}/..."
  aws s3 sync "$DIST_DIR" "s3://${SDK_BUCKET}/${prefix}/" \
    --content-type "application/javascript" \
    --cache-control "$js_cache" \
    --exclude "*.map" \
    --profile siteqwality

  # Source maps: long cache, not requested by browsers.
  aws s3 sync "$DIST_DIR" "s3://${SDK_BUCKET}/${prefix}/" \
    --content-type "application/json" \
    --cache-control "public, max-age=31536000" \
    --exclude "*" \
    --include "*.map" \
    --profile siteqwality
}

upload "$PINNED_PREFIX" "public, max-age=31536000, immutable"
upload "$MAJOR_PREFIX" "public, max-age=86400"

echo "Upload complete: ${PINNED_PREFIX}/ (pinned) and ${MAJOR_PREFIX}/ (latest ${MAJOR}.x)."
echo "Subresource Integrity for ${PINNED_PREFIX}/sdk.min.js:"
echo "  sha384-$(openssl dgst -sha384 -binary "$DIST_DIR/sdk.min.js" | openssl base64 -A)"

if [ -n "$CDN_DISTRIBUTION_ID" ]; then
  echo "Invalidating CloudFront cache for /${MAJOR_PREFIX}/*..."
  aws cloudfront create-invalidation \
    --distribution-id "$CDN_DISTRIBUTION_ID" \
    --paths "/${MAJOR_PREFIX}/*" \
    --profile siteqwality
  echo "Invalidation submitted."
else
  echo "Skipping CloudFront invalidation (no distribution ID provided)."
  echo "Usage: ./deploy.sh <distribution-id>"
fi
