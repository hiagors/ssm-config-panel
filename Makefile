#
# Todos os alvos rodam através de `mise exec`, para usar exatamente as
# versões pinadas no mise.toml — independente do que esteja ativado no shell.
# Nenhum alvo usa sudo, e nenhum baixa o instalador oficial da AWS: o
# awscli vem do próprio mise.
#

SHELL := /usr/bin/env bash
MISE  := mise
RUN   := $(MISE) exec --

.DEFAULT_GOAL := help
.PHONY: help setup check-deps dev test test-watch lint build start seed clean

help: ## Lista os alvos disponíveis
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## Instala as ferramentas do mise.toml e as dependências npm
	@command -v $(MISE) >/dev/null 2>&1 || { \
		echo "mise não encontrado. Instale com:  brew install mise"; \
		exit 1; \
	}
	$(MISE) trust
	$(MISE) install
	@if [ -f package-lock.json ]; then \
		$(RUN) npm ci; \
	else \
		echo "package-lock.json ausente; usando npm install para gerá-lo."; \
		$(RUN) npm install; \
	fi
	@if [ ! -f .env ]; then cp .env.example .env; echo "Criado .env a partir de .env.example."; fi
	@$(MAKE) --no-print-directory check-deps

check-deps: ## Verifica que mise, Node e aws v2 vêm do diretório do mise
	@bash scripts/check-deps.sh

dev: ## Sobe o servidor de desenvolvimento com hot reload em 127.0.0.1
	$(RUN) npm run dev

test: ## Roda os testes unitários
	$(RUN) npm run test

test-watch: ## Roda os testes em modo watch
	$(RUN) npm run test:watch

lint: ## Checagem de tipos e diagnósticos do Astro
	$(RUN) npm run lint

build: ## Gera o build de produção (servidor standalone)
	$(RUN) npm run build

start: build ## Roda o build standalone em loopback
	HOST=127.0.0.1 $(RUN) npm run start

seed: ## Cria o parâmetro de exemplo /example/demo/env no store local
	$(RUN) npm run seed

clean: ## Remove build e dependências (preserva .local-store e .backups)
	rm -rf dist .astro node_modules
