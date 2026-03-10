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
# to s3://bucket/rum/v1/

SDK_BUCKET="sq-prod-us-east-1-rum-sdk"
SDK_PREFIX="rum/v1"
DIST_DIR="dist/cdn"
CDN_DISTRIBUTION_ID="${1:-}"

if [ ! -d "$DIST_DIR" ]; then
  echo "Error: $DIST_DIR not found. Run 'npm run build' first."
  exit 1
fi

echo "Uploading SDK files to s3://${SDK_BUCKET}/${SDK_PREFIX}/..."
aws s3 sync "$DIST_DIR" "s3://${SDK_BUCKET}/${SDK_PREFIX}/" \
  --content-type "application/javascript" \
  --cache-control "public, max-age=86400" \
  --exclude "*.map" \
  --profile siteqwality

# Upload source maps separately (longer cache, not served to browsers)
aws s3 sync "$DIST_DIR" "s3://${SDK_BUCKET}/${SDK_PREFIX}/" \
  --content-type "application/json" \
  --cache-control "public, max-age=31536000" \
  --exclude "*" \
  --include "*.map" \
  --profile siteqwality

echo "Upload complete."

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
