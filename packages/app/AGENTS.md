## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

- `opencode dev web` proxies `https://app.opencode.ai`, so local UI/CSS changes will not show there.
- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/opencode`): `bun run --conditions=browser ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls
- Swarm dashboard alignment UI should read the `alignment` payload from `/swarm/:id/admin`; keep gate, contract, and approval copy derived from that read model instead of reconstructing worker prompt details client-side.
- Swarm delivery UI lives on `/:dir/swarm/:id/run` and should read the authoritative `/swarm/:id/delivery` contract; keep the admin console on `/:dir/swarm/:id` so run monitoring and admin controls stay separate.
- Swarm run action panels should mutate through the delivery write routes and then refresh the same `/:dir/swarm/:id/run` detail resource instead of patching local decision or question state by hand.
- Swarm run ship-status and audit panels should derive their copy from `/swarm/:id/delivery` `state`, `commit`, and `audit` fields; do not rebuild delivery history from EventSource payloads in the UI.

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
