-include .env
export

.PHONY: db-up db-down db-reset migrate run test psql

db-up:
	docker compose up -d --wait db

db-down:
	docker compose down

# Drops all local data.
db-reset:
	docker compose down -v
	docker compose up -d --wait db
	go run ./cmd/migrate

migrate:
	go run ./cmd/migrate

run:
	go run ./cmd/server

test:
	go test ./...

psql:
	docker compose exec db psql -U ato -d ato
