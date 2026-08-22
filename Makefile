# bean-counter — the single entry point for every task in this repo.
# Run `make help` (the default) to see what's available.

.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose
REQUIRED_NODE_MAJOR := 22

.PHONY: help setup dev db-up db-down db-reset db-check migrate seed test lint typecheck \
        analytics-export notebook clean check-node infra-synth

help: ## Show this help
	@echo "bean-counter — make targets"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo

check-node: ## Fail unless the active Node is v22.x
	@node_version="$$(node -v 2>/dev/null)"; \
	if [ -z "$$node_version" ]; then \
		echo "ERROR: node not found. Install Node $(REQUIRED_NODE_MAJOR) (see .nvmrc) and run 'nvm use'."; \
		exit 1; \
	fi; \
	major="$$(echo "$$node_version" | sed -E 's/^v([0-9]+)\..*/\1/')"; \
	if [ "$$major" != "$(REQUIRED_NODE_MAJOR)" ]; then \
		echo "ERROR: Node $(REQUIRED_NODE_MAJOR).x is required, but 'node -v' reports $$node_version."; \
		echo "       This machine defaults to Node 18. Run:  nvm use"; \
		echo "       (the version is pinned in .nvmrc)"; \
		exit 1; \
	fi; \
	echo "Node $$node_version OK"

setup: check-node ## Check Node version and install backend + frontend dependencies
	npm install
	cd backend && npm install
	cd frontend && npm install
	@echo "Setup complete. Next: start Docker Desktop, then:"
	@echo "  make db-up && make migrate && make seed && make dev"

dev: db-up ## Start Postgres, then run backend and frontend together
	@set -a; [ -f .env ] && . ./.env; set +a; \
	npx concurrently --names backend,frontend --prefix-colors green,cyan \
		"cd backend && npm run dev" \
		"cd frontend && npm run dev"

db-up: ## Start the Postgres container and wait for it to be healthy
	$(COMPOSE) up -d --wait postgres

db-down: ## Stop the Postgres container (data is kept)
	$(COMPOSE) down

db-check: ## Report which Postgres the current DATABASE_URL actually reaches
	@set -a; [ -f .env ] && . ./.env; set +a; \
	url="$${DATABASE_URL:-}"; \
	if [ -z "$$url" ]; then \
		echo "ERROR: DATABASE_URL is not set. Run: cp .env.example .env"; exit 1; \
	fi; \
	target="$$(echo "$$url" | sed -E 's|^[^:]+://([^@/]*@)?||')"; \
	echo "DATABASE_URL -> $$target"; \
	psql_bin="$$(command -v psql || true)"; \
	for candidate in /usr/local/opt/postgresql@18/bin/psql /opt/homebrew/opt/postgresql@18/bin/psql; do \
		[ -n "$$psql_bin" ] && break; \
		[ -x "$$candidate" ] && psql_bin="$$candidate"; \
	done; \
	if [ -z "$$psql_bin" ]; then \
		echo "No psql on this machine — checking the container instead:"; \
		$(COMPOSE) exec -T postgres psql -U "$${POSTGRES_USER:-beancounter}" -d "$${POSTGRES_DB:-bean_counter}" \
			-tAc "select 'container postgres ' || current_setting('server_version')" \
			|| { echo "Could not reach the container either. Try: make db-up"; exit 1; }; \
		echo "NOTE: this checked the container directly, not DATABASE_URL."; exit 0; \
	fi; \
	server="$$("$$psql_bin" "$$url" -tAc "select current_setting('server_version')" 2>&1)" \
		|| { echo "Could not connect: $$server"; echo "If you meant the container, run: make db-up"; exit 1; }; \
	echo "Connected. Postgres $$(echo $$server)"; \
	port="$$(echo "$$target" | sed -E 's|.*:([0-9]+).*|\1|')"; \
	if [ -n "$$($(COMPOSE) ps -q postgres 2>/dev/null)" ] && [ "$$port" = "$${POSTGRES_PORT:-5432}" ]; then \
		echo "This is the bean-counter container (compose service 'postgres')."; \
	else \
		echo "This is NOT the bean-counter container — a native/other Postgres is answering on $$port."; \
	fi

db-reset: ## Destroy the database volume, then re-create and migrate it
	$(COMPOSE) down -v
	$(MAKE) db-up
	$(MAKE) migrate
	@echo "Database reset. Run 'make seed' to load the sample week."

migrate: ## Apply database migrations (implemented in backend/)
	@set -a; [ -f .env ] && . ./.env; set +a; \
	cd backend && npm run migrate

seed: ## Load the sample week of coffee-shop events (implemented in backend/)
	@set -a; [ -f .env ] && . ./.env; set +a; \
	cd backend && npm run seed

test: ## Run backend + frontend test suites
	cd backend && npm test
	cd frontend && npm test

lint: ## Lint backend + frontend
	cd backend && npm run lint
	cd frontend && npm run lint

typecheck: ## TypeScript check for backend + frontend
	cd backend && npm run typecheck
	cd frontend && npm run typecheck

analytics-export: ## Dump the read model to analytics/data/*.parquet (implemented in analytics/)
	$(MAKE) -C analytics export

notebook: ## Launch the analytics notebook server (implemented in analytics/)
	$(MAKE) -C analytics notebook

infra-synth: check-node ## Render the infra/ CDK stack to cdk.out/ (offline, never touches AWS — see infra/README.md)
	@echo "infra/ has NEVER been deployed and has NOT been security reviewed — see infra/README.md."
	@echo "This only renders the CloudFormation template locally; it does not call AWS."
	cd infra && npx cdk synth --ignore-errors
	@echo
	@echo "--ignore-errors was used: any failed context lookup (e.g. AWS credentials) was"
	@echo "papered over with dummy values, so the template above may not reflect a real"
	@echo "account/region. Do not treat this as validated input to 'cdk deploy'."

clean: ## Remove build output and installed dependencies
	rm -rf node_modules backend/node_modules backend/dist frontend/node_modules frontend/dist
	rm -rf analytics/.venv analytics/__pycache__ analytics/.ipynb_checkpoints
	@echo "Clean. Run 'make setup' to reinstall."
