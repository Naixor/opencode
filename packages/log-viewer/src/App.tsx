import { createBrowserRouter, RouterProvider } from "react-router"
import { Layout } from "./Layout"
import { LogListPage } from "./pages/LogListPage"
import { LogDetailPage } from "./pages/LogDetailPage"
import { StatsPage } from "./pages/StatsPage"
import { AnalyzePage } from "./pages/AnalyzePage"

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <LogListPage /> },
      { path: "/logs/:id", element: <LogDetailPage /> },
      { path: "/stats", element: <StatsPage /> },
      { path: "/analyze", element: <AnalyzePage /> },
    ],
  },
])

export function App() {
  return <RouterProvider router={router} />
}
