.PHONY: bootstrap lint test

bootstrap:
	uv sync
	uv run repo-warden bootstrap

lint:
	uv run ruff check .
	uv run ruff format --check .
	uv run pyright

test:
	uv run pytest -q
