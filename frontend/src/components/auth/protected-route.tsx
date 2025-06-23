"use client"

import type React from "react"

import { useAuth } from "@/contexts/auth-context"
import LoginForm from "./login-form"
import { useState } from "react"

interface ProtectedRouteProps {
  children: React.ReactNode
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, login, isLoading } = useAuth()
  const [loginError, setLoginError] = useState("")

  const handleLogin = async (email: string, password: string) => {
    setLoginError("")
    const success = await login(email, password)
    if (!success) {
      setLoginError("Invalid email or password. Try admin@atiuscapital.com / password123")
    }
  }

  if (!user) {
    return (
      <div>
        <LoginForm onLogin={handleLogin} isLoading={isLoading} />
        {loginError && (
          <div className="fixed bottom-4 right-4 bg-gray-800 border border-gray-600 text-white p-4 rounded-lg shadow-lg max-w-sm">
            <div className="flex items-start space-x-2">
              <div className="w-2 h-2 bg-red-500 rounded-full mt-2 flex-shrink-0"></div>
              <p className="text-sm">{loginError}</p>
            </div>
          </div>
        )}
      </div>
    )
  }

  return <>{children}</>
}
