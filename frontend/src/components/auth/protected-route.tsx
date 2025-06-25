"use client"

import React, { useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import LoginForm from './login-form';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, login, isLoading } = useAuth();
  const [loginError, setLoginError] = useState("");

  const handleLogin = async (email: string, password: string) => {
    setLoginError("");
    try {
      await login(email, password);
    } catch (error: any) {
      setLoginError(error.message || "Invalid email or password. Try admin@atiuscapital.com / password123");
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <LoginForm onLogin={() => {}} />
          {loginError && (
            <div className="mt-4 p-4 bg-red-900/20 border border-red-500/30 rounded-lg">
              <p className="text-red-400 text-sm text-center">{loginError}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
