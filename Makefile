GO ?= go
PNPM ?= pnpm

.PHONY: backend-test backend-build frontend-install frontend-check frontend-build build test

backend-test:
	cd backend && $(GO) test ./...

backend-build:
	cd backend && $(GO) build -o server ./cmd/server

frontend-install:
	cd frontend && $(PNPM) install

frontend-check:
	cd frontend && $(PNPM) check

frontend-build:
	cd frontend && $(PNPM) build

test: backend-test frontend-check

build: backend-build frontend-build
