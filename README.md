# qltracker-realtime

Small self-hosted Socket.IO + Postgres backend for QLTracker.

## What it does

- accepts normalized server snapshots over HTTP
- persists the latest snapshot in Postgres
- broadcasts live updates over Socket.IO
- lets clients subscribe to specific server addresses

## Quick start

1. Copy `.env.example` to `.env`.
2. Create the tables from `sql/schema.sql`.
3. Install dependencies with `npm install`.
4. Run `npm run dev`.

## HTTP endpoints

- `GET /health`
- `GET /api/servers/:addr`
- `POST /api/ingest/server-snapshot`

## Socket events

- client -> server: `servers:subscribe` with `{ addrs: string[] }`
- server -> client: `server:snapshot`
