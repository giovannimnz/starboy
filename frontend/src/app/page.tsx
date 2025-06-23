import ProtectedRoute from "@/components/auth/protected-route"
import Dashboard from "@/components/dashboard"

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <ProtectedRoute>
        <Dashboard />
      </ProtectedRoute>
    </main>
  )
}
