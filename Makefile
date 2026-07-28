# Thin, discoverable wrappers. `make help` lists everything.
.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help setup dev web mobile worker up inbox stack down test typecheck lint smoke e2e db-migrate db-seed db-reset studio clean

help: ## show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## one-command bootstrap: .env, deps, docker infra, migrate, seed
	@bash scripts/setup.sh

dev: ## run web + worker (infra must be up: make up)
	@npm run dev

web: ## run only the web app on :3200
	@npm run dev:web

mobile: ## run the Expo dev server (scan the QR with Expo Go)
	@npm run dev:mobile

worker: ## run only the background worker
	@npm run dev:worker

up: ## start postgres + redis + the local mail inbox
	@npm run infra:up

inbox: ## print the local mail inbox URL (confirmation links land here)
	@echo "Local mail inbox: http://localhost:8035"
	@command -v xdg-open >/dev/null && xdg-open http://localhost:8035 >/dev/null 2>&1 || true

down: ## stop postgres + redis
	@npm run infra:down

stack: ## build and run EVERYTHING in docker (web, worker, db, redis)
	@npm run stack:up

test: ## unit tests (all workspaces)
	@npm run test

typecheck: ## tsc --noEmit across all workspaces
	@npm run typecheck

lint: ## eslint across all workspaces
	@npm run lint

e2e: ## playwright end-to-end tests against the web app
	@npm run test:e2e

smoke: ## boot the real app and drive the core journey (the merge gate)
	@npm run smoke

db-migrate: ## create + apply a migration from schema changes
	@npm run db:migrate

db-seed: ## seed a demo org + user + items
	@npm run db:seed

db-reset: ## DROP the dev database and re-migrate + re-seed
	@npm run db:reset

studio: ## open Prisma Studio
	@npm run db:studio

clean: ## remove build output and caches (keeps node_modules)
	@rm -rf .turbo apps/*/.next apps/*/dist apps/*/.expo packages/*/dist coverage test-results
