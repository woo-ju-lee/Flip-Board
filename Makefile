.PHONY: install dev backend frontend build test validate serve

install:
	python3 -m venv .venv
	.venv/bin/python -m pip install -r requirements-lock.txt
	.venv/bin/python -m pip install --no-deps -e .
	cd frontend && npm ci

backend:
	.venv/bin/uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000

frontend:
	cd frontend && npm run dev

dev:
	@echo 'Run make backend and make frontend in separate terminals.'

build:
	cd frontend && npm run build

test:
	.venv/bin/pytest -q
	cd frontend && npm test

validate:
	.venv/bin/python scripts/manage_geometry.py validate backend/data

serve: build
	.venv/bin/uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --workers 1
