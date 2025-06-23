"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"
import axios from "axios";

interface User {
  id: string
  email: string
  name: string
}

interface AuthContextType {
  user: User | null
  token: string | null
  login: (email: string, password: string) => Promise<boolean>
  logout: () => void
  isLoading: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true); // Começa como true para verificar o localStorage

  // Verifica se já existe uma sessão salva no navegador
  useEffect(() => {
    try {
      const savedUser = localStorage.getItem("atius-user")
      const savedToken = localStorage.getItem("atius-token")
      if (savedUser && savedToken) {
        setUser(JSON.parse(savedUser))
        setToken(savedToken)
      }
    } catch (error) {
        console.error("Failed to parse user data from localStorage", error)
        localStorage.clear();
    }
    setIsLoading(false); // Termina o carregamento inicial
  }, [])

  const login = async (email: string, password: string): Promise<boolean> => {
    setIsLoading(true)
    try {
      // Faz a chamada para a sua API backend
      const response = await axios.post("http://localhost:8001/api/login", {
        email,
        senha: password, // Note que o backend espera 'senha'
      });

      if (response.data && response.data.token) {
        const { user: userData, token: authToken } = response.data;
        
        // Salva os dados no estado e no localStorage
        setUser(userData)
        setToken(authToken)
        localStorage.setItem("atius-user", JSON.stringify(userData))
        localStorage.setItem("atius-token", authToken)
        
        setIsLoading(false)
        return true
      }
      // Se a resposta não tiver o token, algo deu errado
      setIsLoading(false)
      return false

    } catch (error) {
      console.error("Falha no login:", error)
      setIsLoading(false)
      return false
    }
  }

  const logout = () => {
    setUser(null)
    setToken(null)
    localStorage.removeItem("atius-user")
    localStorage.removeItem("atius-token")
  }

  // Não renderiza nada enquanto verifica a sessão inicial
  if (isLoading) {
    return <div>Carregando...</div>; // Ou um componente de spinner
  }

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isLoading: false }}>
      {children}
    </AuthContext.Provider>
  )
}