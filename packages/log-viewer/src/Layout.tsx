import { NavLink, Outlet } from "react-router"

const navItems = [
  { to: "/", label: "Logs" },
  { to: "/stats", label: "Stats" },
  { to: "/analyze", label: "Analyze" },
]

export function Layout() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-800 px-4 py-3 flex items-center gap-6">
        <a
          href="/manager/app"
          className="text-base font-semibold tracking-tight text-zinc-100 hover:text-zinc-300 transition-colors no-underline"
        >
          OpenCode
        </a>
        <nav className="flex items-center gap-1">
          <a
            href="/manager/app"
            className="px-3 py-1.5 rounded text-sm font-medium transition-colors text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          >
            Dashboard
          </a>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }: { isActive: boolean }) =>
                `px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  isActive ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  )
}
