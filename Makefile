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

TEST_DATABASE_URL ?= postgres://ato:ato@localhost:5432/ato_test?sslmode=disable

# Unit tests + DB integration tests against a separate ato_test database.
test: db-up
	@docker compose exec -T db psql -U ato -d ato -tAc "select 1 from pg_database where datname = 'ato_test'" | grep -q 1 \
		|| docker compose exec -T db createdb -U ato ato_test
	TEST_DATABASE_URL=$(TEST_DATABASE_URL) go test ./...

psql:
	docker compose exec db psql -U ato -d ato
