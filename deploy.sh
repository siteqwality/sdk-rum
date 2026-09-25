#!/bin/bash
set -euo pipefail

# Deploy RUM SDK to CloudFront CDN
# Usage: ./deploy.sh [distribution-id]
#
# Requires:
#   - AWS CLI configured with siteqwality profile
#   - SDK already built (npm run build)
#
# Uploads ALL files in dist/cdn/ (core SDK + lazy-loaded rrweb chunk)
# to s3://bucket/rum/v<version>/ (immutable) and s3://bucket/rum/v1/ (latest 1.x)

SDK_BUCKET="sq-prod-us-east-1-rum-sdk"
SDK_PREFIX="rum/v1"
DIST_DIR="dist/cdn"
CDN_DISTRIBUTION_ID="${1:-}"
VERSION="$(node -p "require('./package.json').version")"
# rum/v<exact version>/ never changes once written, so customers can pin a
# release (and use Subresource Integrity). rum/v1/ follows the latest 1.x.
PINNED_PREFIX="rum/v${VERSION}"

if [ ! -d "$DIST_DIR" ]; then
  echo "Error: $DIST_DIR not found. Run 'npm run build' first."
  exit 1
fi

if aws s3 ls "s3://${SDK_BUCKET}/${PINNED_PREFIX}/sdk.min.js" --profile siteqwality >/dev/null 2>&1; then
  echo "Error: ${PINNED_PREFIX}/ is already published and is immutable. Bump the version in package.json."
  exit 1
fi

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
upload "$SDK_PREFIX" "public, max-age=86400"

echo "Upload complete: ${PINNED_PREFIX}/ (pinned) and ${SDK_PREFIX}/ (latest 1.x)."

if [ -n "$CDN_DISTRIBUTION_ID" ]; then
  echo "Invalidating CloudFront cache..."
  aws cloudfront create-invalidation \
    --distribution-id "$CDN_DISTRIBUTION_ID" \
    --paths "/${SDK_PREFIX}/*" \
    --profile siteqwality
  echo "Invalidation submitted."
else
  echo "Skipping CloudFront invalidation (no distribution ID provided)."
  echo "Usage: ./deploy.sh <distribution-id>"
fi
