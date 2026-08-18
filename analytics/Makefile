# bean-counter analytics — Python, managed with uv.
# The repo-root Makefile delegates here: `make analytics-export` -> `export`,
# `make notebook` -> `notebook`. Keep those two target names stable.

.DEFAULT_GOAL := help
SHELL := /bin/bash

UV := uv
NOTEBOOK := notebooks/01-shrinkage.ipynb
SNAPSHOT := data/events.parquet data/stock.parquet

.PHONY: help install install-db fixtures export notebook execute clean

help: ## Show this help
	@echo "bean-counter analytics — make targets"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo

install: ## Create the venv and install analytics dependencies
	$(UV) sync

install-db: ## Install the optional psycopg extra (only needed to run 'make export')
	$(UV) sync --extra db

fixtures: ## Regenerate the sample snapshot in data/ (no database needed)
	$(UV) run python scripts/make_fixtures.py

# The snapshot is a generated artifact (it is gitignored), so anything that needs it
# builds it from fixtures first. A fresh clone runs the notebook with no extra steps.
$(SNAPSHOT):
	$(MAKE) fixtures

export: install-db ## Export the live read model + event log to data/*.parquet (needs DATABASE_URL)
	$(UV) run python scripts/export.py

notebook: install $(SNAPSHOT) ## Launch Jupyter on the shrinkage notebook
	$(UV) run jupyter lab $(NOTEBOOK)

execute: install $(SNAPSHOT) ## Run the notebook top-to-bottom and fail on any error (the CI check)
	$(UV) run jupyter nbconvert --to notebook --execute --inplace $(NOTEBOOK)

clean: ## Remove the venv, caches, and the generated snapshot
	rm -rf .venv __pycache__ scripts/__pycache__ .ipynb_checkpoints notebooks/.ipynb_checkpoints
	rm -f data/events.parquet data/stock.parquet
	@echo "Clean. Run 'make install' to reinstall."
