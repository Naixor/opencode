import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { ManagerState } from "../manager-state"

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode Manager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
    }
    .nav {
      background: #111;
      border-bottom: 1px solid #222;
      padding: 0 24px;
      height: 48px;
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .nav-brand {
      font-weight: 600;
      color: #fff;
      font-size: 0.95rem;
      text-decoration: none;
    }
    .nav-links {
      display: flex;
      gap: 4px;
    }
    .nav-link {
      color: #888;
      text-decoration: none;
      font-size: 0.85rem;
      padding: 6px 12px;
      border-radius: 6px;
      transition: all 0.15s;
    }
    .nav-link:hover { color: #fff; background: #1a1a1a; }
    .nav-link.active { color: #5b9bd5; background: #1a1a2e; }
    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 60px 24px;
    }
    h1 {
      font-size: 1.8rem;
      margin-bottom: 0.4rem;
      color: #fff;
    }
    .subtitle {
      color: #666;
      margin-bottom: 3rem;
      font-size: 0.9rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }
    .card {
      background: #141414;
      border: 1px solid #252525;
      border-radius: 10px;
      padding: 20px;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.2s, transform 0.15s;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card:hover {
      border-color: #5b9bd5;
      transform: translateY(-1px);
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-icon {
      font-size: 1.4rem;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #1a1a2e;
      border-radius: 8px;
      flex-shrink: 0;
    }
    .card h2 {
      font-size: 1rem;
      color: #fff;
      font-weight: 600;
    }
    .card p {
      color: #777;
      font-size: 0.82rem;
      line-height: 1.4;
    }
    .card .url {
      color: #4a8bbf;
      font-size: 0.75rem;
      font-family: monospace;
      margin-top: auto;
    }
    .empty {
      text-align: center;
      color: #555;
      padding: 60px 0;
    }
    .empty p { margin-bottom: 8px; }
    .empty code {
      background: #1a1a1a;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 0.85rem;
      color: #888;
    }
  </style>
</head>
<body>
  <nav class="nav">
    <a class="nav-brand" href="/manager/app">OpenCode</a>
    <div class="nav-links" id="nav-links">
      <a class="nav-link active" href="/manager/app">Dashboard</a>
    </div>
  </nav>
  <div class="container">
    <h1>Services</h1>
    <p class="subtitle">All available web services</p>
    <div class="grid" id="grid"></div>
    <div class="empty" id="empty" style="display:none">
      <p>No services registered.</p>
      <p>Start with <code>lark-opencode manager</code> to enable all services.</p>
    </div>
  </div>
  <script>
    const grid = document.getElementById('grid');
    const nav = document.getElementById('nav-links');
    const empty = document.getElementById('empty');

    function render(services) {
      grid.innerHTML = '';
      nav.innerHTML = '<a class="nav-link active" href="/manager/app">Dashboard</a>';
      empty.style.display = services.length ? 'none' : 'block';
      services.forEach(s => {
        const a = document.createElement('a');
        a.href = s.url;
        a.className = 'card';
        a.innerHTML = '<div class="card-header"><div class="card-icon">' + s.icon +
          '</div><h2>' + s.name + '</h2></div><p>' + s.description +
          '</p><span class="url">' + s.url + '</span>';
        grid.appendChild(a);
        if (s.id === 'dashboard') return;
        const link = document.createElement('a');
        link.href = s.url;
        link.className = 'nav-link';
        link.textContent = s.name;
        nav.appendChild(link);
      });
    }

    function load() {
      fetch('/manager/services')
        .then(r => r.json())
        .then(render)
        .catch(() => {});
    }

    load();
    setInterval(load, 2000);
  </script>
</body>
</html>`

export const ManagerRoutes = lazy(() =>
  new Hono()
    .get(
      "/app",
      describeRoute({
        summary: "Manager Dashboard",
        description: "Serve the Manager dashboard web interface.",
        operationId: "manager.app",
      }),
      (c) => {
        return c.html(DASHBOARD_HTML)
      },
    )
    .get(
      "/services",
      describeRoute({
        summary: "List registered services",
        description: "Get the list of web services registered with the manager.",
        operationId: "manager.services",
        responses: {
          200: {
            description: "List of services",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      id: z.string(),
                      name: z.string(),
                      description: z.string(),
                      url: z.string(),
                      icon: z.string(),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      (c) => {
        return c.json(ManagerState.list())
      },
    ),
)
