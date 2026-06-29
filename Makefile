# manifest-plugins developer commands
#
# One-shot entrypoints for the common workflows. Each target is a thin
# wrapper around the underlying script — `make` exists so you don't
# have to remember which script does what.
#
# Quick reference:
#   make help         print this message
#   make install      install dev deps (npm install)
#   make build        compile the plugins package (tsc + filter)
#   make test         run jest with coverage
#   make e2e IMAGE=tag run the end-to-end dashboard test
#   make apply DIR=…  apply the plugin host to a Manifest checkout
#   make verify DIR=… verify the plugin host is applied to a Manifest checkout
#   make pipeline …   build a manifest-with-plugins image via the pipeline

.PHONY: help install build test e2e apply verify pipeline clean

# Default image tag for `make e2e`. Override with `make e2e IMAGE=foo`.
IMAGE ?= manifest-with-plugins:latest

# Default Manifest checkout for `make apply` / `make verify`.
DIR ?= ../manifest

help: ## print available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## install dev dependencies (uses --legacy-peer-deps for the ts-node peer-dep conflict)
	npm install --legacy-peer-deps

build: ## compile the plugins package (tsc + post-build filter)
	npm run build

test: ## run jest with 100% coverage enforcement
	npm run test:coverage

e2e: ## run the end-to-end test against IMAGE (default: manifest-with-plugins:latest)
	@bash pipeline/e2e-test.sh $(IMAGE)

apply: ## apply the plugin host to a Manifest checkout (DIR=path)
	@npm run apply -- $(DIR)

verify: ## verify the plugin host is installed in a Manifest checkout (DIR=path)
	@npm run verify -- $(DIR)

pipeline: ## build + e2e-test a manifest-with-plugins image via the full pipeline
	@bash pipeline/build-and-publish.sh

clean: ## remove build artifacts and node_modules
	rm -rf dist node_modules packages/*/dist packages/*/node_modules