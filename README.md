# Yeti Nail Studio MCP Demo

A small Streamable HTTP MCP server for a fictional nail salon demo with Convai.

## Tools

- `get_services`
- `check_available_slots`
- `create_booking`
- `search_products`
- `check_product_stock`

## Endpoints

- `/mcp` — MCP endpoint
- `/` — health/info
- `/bookings` — browser-verifiable demo bookings

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000/`.

## Render

Build command: `npm install`
Start command: `npm start`

After deployment, use this in Convai:

`https://YOUR-SERVICE.onrender.com/mcp`

### Important demo limitation

Bookings are stored in server memory for the first prototype. On Render Free, the web service sleeps after 15 minutes of inactivity and memory is lost on sleep/restart/redeploy. This is intentional for milestone 1: prove the Convai -> MCP -> tool call flow. In milestone 2, replace memory with persistent storage/API.
