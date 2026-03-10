.PHONY: build deploy

build:
	npm run build

deploy: build
	AWS_PROFILE=siteqwality ./deploy.sh E23MTP7VCRLRPV
