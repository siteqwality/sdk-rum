.PHONY: build check deploy probe

build:
	npm run clean && npm run build

# Never ship a CDN core that leaks globals or misses its budget.
check: build
	npm test && npm run test:bundle && npm run test:browser

deploy: check
	AWS_PROFILE=siteqwality ./deploy.sh E23MTP7VCRLRPV

# The same bundle checks against the live file, after a deploy.
probe:
	SDK_BUNDLE_URL=https://cdn.siteqwality.com/rum/v1/sdk.min.js npm run test:bundle
