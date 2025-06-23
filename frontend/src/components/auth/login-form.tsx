"use client"

import type React from "react"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Eye, EyeOff, Lock, Mail, User, CheckCircle, XCircle } from "lucide-react"

interface LoginFormProps {
  onLogin: (email: string, password: string) => void
  isLoading: boolean
  setIsLoading: (loading: boolean) => void
}

export default function LoginForm({ onLogin, isLoading, setIsLoading }: LoginFormProps) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [currentView, setCurrentView] = useState<"login" | "register" | "forgot">("login")
  const [forgotEmail, setForgotEmail] = useState("")
  const [registerData, setRegisterData] = useState({
    firstName: "",
    lastName: "",
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
  })
  const [registerErrors, setRegisterErrors] = useState<any>({})
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  // Modal states
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [showErrorModal, setShowErrorModal] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")

  const validateForm = () => {
    const newErrors: { email?: string; password?: string } = {}

    if (!email) {
      newErrors.email = "Email is required"
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      newErrors.email = "Email is invalid"
    }

    if (!password) {
      newErrors.password = "Password is required"
    } else if (password.length < 6) {
      newErrors.password = "Password must be at least 6 characters"
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const validateRegisterForm = () => {
    const newErrors: any = {}

    if (!registerData.firstName) {
      newErrors.firstName = "Nome é obrigatório"
    } else if (registerData.firstName.length > 20) {
      newErrors.firstName = "Nome deve ter no máximo 20 caracteres"
    }

    if (!registerData.lastName) {
      newErrors.lastName = "Sobrenome é obrigatório"
    } else if (registerData.lastName.length > 20) {
      newErrors.lastName = "Sobrenome deve ter no máximo 20 caracteres"
    }

    if (!registerData.username) {
      newErrors.username = "Usuário é obrigatório"
    } else if (registerData.username.length > 20) {
      newErrors.username = "Usuário deve ter no máximo 20 caracteres"
    }

    if (!registerData.email) {
      newErrors.email = "Email é obrigatório"
    } else if (!/\S+@\S+\.\S+/.test(registerData.email)) {
      newErrors.email = "Email é inválido"
    } else if (registerData.email.length > 50) {
      newErrors.email = "Email deve ter no máximo 50 caracteres"
    }

    if (!registerData.password) {
      newErrors.password = "Senha é obrigatória"
    } else if (registerData.password.length < 12) {
      newErrors.password = "Senha deve ter pelo menos 12 caracteres"
    } else if (!/(?=.*[a-zA-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/.test(registerData.password)) {
      newErrors.password = "Senha deve conter letra, número e caractere especial"
    }

    if (!registerData.confirmPassword) {
      newErrors.confirmPassword = "Confirmação de senha é obrigatória"
    } else if (registerData.password !== registerData.confirmPassword) {
      newErrors.confirmPassword = "Senhas não coincidem"
    }

    setRegisterErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!forgotEmail) return

    setIsLoading(true)
    // Simular envio de email
    await new Promise((resolve) => setTimeout(resolve, 1500))
    setIsLoading(false)

    alert(`Instruções de recuperação enviadas para ${forgotEmail}`)
    setCurrentView("login")
    setForgotEmail("")
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateRegisterForm()) return

    setIsLoading(true)

    try {
      // Simular cadastro com possibilidade de erro
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Simular diferentes cenários (90% sucesso, 10% erro)
      const isSuccess = Math.random() > 0.1

      if (isSuccess) {
        // Sucesso - mostrar modal de sucesso
        setIsLoading(false)
        setShowSuccessModal(true)
      } else {
        // Erro - mostrar modal de erro
        const errorMessages = [
          "Email já está em uso por outro usuário",
          "Nome de usuário não está disponível",
          "Erro interno do servidor. Tente novamente mais tarde",
          "Dados inválidos. Verifique as informações e tente novamente",
        ]
        const randomError = errorMessages[Math.floor(Math.random() * errorMessages.length)]

        setIsLoading(false)
        setErrorMessage(randomError)
        setShowErrorModal(true)
      }
    } catch (error) {
      setIsLoading(false)
      setErrorMessage("Erro inesperado. Tente novamente mais tarde")
      setShowErrorModal(true)
    }
  }

  const handleSuccessModalClose = () => {
    setShowSuccessModal(false)
    // Limpar dados do formulário
    setRegisterData({
      firstName: "",
      lastName: "",
      username: "",
      email: "",
      password: "",
      confirmPassword: "",
    })
    setRegisterErrors({})
    // Redirecionar para login
    setCurrentView("login")
  }

  const handleErrorModalClose = () => {
    setShowErrorModal(false)
    setErrorMessage("")
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (validateForm()) {
      onLogin(email, password)
    }
  }

  return (
    <>
      <div className="min-h-screen flex items-center justify-center bg-dark-gradient p-4">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <h1 className="text-4xl font-bold text-gradient mb-2">Atius Capital</h1>
            <p className="text-gray-400">Plataforma de Trading Profissional</p>
          </div>

          <Card className="bg-card-dark shadow-soft-xl border-gray-700">
            {currentView === "login" && (
              <>
                <CardHeader className="space-y-1">
                  <CardTitle className="text-2xl text-center text-white">Entrar</CardTitle>
                  <CardDescription className="text-center text-gray-400">
                    Digite suas credenciais para acessar sua conta de trading
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email" className="text-white">
                        Email
                      </Label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                        <Input
                          id="email"
                          type="email"
                          placeholder="Digite seu email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="pl-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                      </div>
                      {errors.email && <p className="text-red-400 text-sm">{errors.email}</p>}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="password" className="text-white">
                        Senha
                      </Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          placeholder="Digite sua senha"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="pl-10 pr-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-3 text-gray-400 hover:text-gray-200 transition-colors"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {errors.password && <p className="text-red-400 text-sm">{errors.password}</p>}
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <input
                          id="remember"
                          type="checkbox"
                          className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-orange-500 focus:ring-orange-500 focus:ring-1 accent-orange-500"
                        />
                        <Label htmlFor="remember" className="text-sm text-gray-400">
                          Lembrar de mim
                        </Label>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCurrentView("forgot")}
                        className="text-sm text-orange-500 hover:text-orange-400 transition-colors"
                      >
                        Esqueceu a senha?
                      </button>
                    </div>

                    <Button
                      type="submit"
                      className="w-full bg-orange-500 hover:bg-orange-600 text-white font-medium transition-colors shadow-soft"
                      disabled={isLoading}
                    >
                      {isLoading ? "Entrando..." : "Entrar"}
                    </Button>
                  </form>

                  <div className="mt-6 text-center">
                    <p className="text-gray-400 text-sm">
                      Não tem uma conta?{" "}
                      <button
                        onClick={() => setCurrentView("register")}
                        className="text-orange-500 hover:text-orange-400 transition-colors font-medium"
                      >
                        Cadastre-se
                      </button>
                    </p>
                  </div>
                </CardContent>
              </>
            )}

            {currentView === "forgot" && (
              <>
                <CardHeader className="space-y-1">
                  <CardTitle className="text-2xl text-center text-white">Recuperar Senha</CardTitle>
                  <CardDescription className="text-center text-gray-400">
                    Digite seu email para receber as instruções de recuperação
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleForgotPassword} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="forgot-email" className="text-white">
                        Email
                      </Label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                        <Input
                          id="forgot-email"
                          type="email"
                          placeholder="Digite seu email cadastrado"
                          value={forgotEmail}
                          onChange={(e) => setForgotEmail(e.target.value)}
                          className="pl-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                          required
                        />
                      </div>
                    </div>

                    <Button
                      type="submit"
                      className="w-full bg-orange-500 hover:bg-orange-600 text-white font-medium transition-colors shadow-soft"
                      disabled={isLoading || !forgotEmail}
                    >
                      {isLoading ? "Enviando..." : "Enviar Instruções"}
                    </Button>
                  </form>

                  <div className="mt-6 text-center">
                    <button
                      onClick={() => setCurrentView("login")}
                      className="text-sm text-gray-400 hover:text-white transition-colors"
                    >
                      ← Voltar ao login
                    </button>
                  </div>
                </CardContent>
              </>
            )}

            {currentView === "register" && (
              <>
                <CardHeader className="space-y-1">
                  <CardTitle className="text-2xl text-center text-white">Criar Conta</CardTitle>
                  <CardDescription className="text-center text-gray-400">
                    Preencha os dados para criar sua conta de trading
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleRegister} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="firstName" className="text-white">
                          Nome
                        </Label>
                        <Input
                          id="firstName"
                          type="text"
                          placeholder="Seu nome"
                          maxLength={20}
                          value={registerData.firstName}
                          onChange={(e) => setRegisterData({ ...registerData, firstName: e.target.value })}
                          className="bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                        {registerErrors.firstName && <p className="text-red-400 text-xs">{registerErrors.firstName}</p>}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="lastName" className="text-white">
                          Sobrenome
                        </Label>
                        <Input
                          id="lastName"
                          type="text"
                          placeholder="Seu sobrenome"
                          maxLength={20}
                          value={registerData.lastName}
                          onChange={(e) => setRegisterData({ ...registerData, lastName: e.target.value })}
                          className="bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                        {registerErrors.lastName && <p className="text-red-400 text-xs">{registerErrors.lastName}</p>}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="username" className="text-white">
                        Usuário
                      </Label>
                      <div className="relative">
                        <User className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                        <Input
                          id="username"
                          type="text"
                          placeholder="Nome de usuário"
                          maxLength={20}
                          value={registerData.username}
                          onChange={(e) => setRegisterData({ ...registerData, username: e.target.value })}
                          className="pl-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                      </div>
                      {registerErrors.username && <p className="text-red-400 text-xs">{registerErrors.username}</p>}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="register-email" className="text-white">
                        Email
                      </Label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                        <Input
                          id="register-email"
                          type="email"
                          placeholder="seu@email.com"
                          maxLength={50}
                          value={registerData.email}
                          onChange={(e) => setRegisterData({ ...registerData, email: e.target.value })}
                          className="pl-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                      </div>
                      {registerErrors.email && <p className="text-red-400 text-xs">{registerErrors.email}</p>}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="register-password" className="text-white">
                        Senha
                      </Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                        <Input
                          id="register-password"
                          type={showPassword ? "text" : "password"}
                          placeholder="Mínimo 12 caracteres"
                          value={registerData.password}
                          onChange={(e) => setRegisterData({ ...registerData, password: e.target.value })}
                          className="pl-10 pr-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-3 text-gray-400 hover:text-gray-200 transition-colors"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <p className="text-xs text-gray-500">Deve conter letra, número e caractere especial</p>
                      {registerErrors.password && <p className="text-red-400 text-xs">{registerErrors.password}</p>}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="confirm-password" className="text-white">
                        Confirmar Senha
                      </Label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                        <Input
                          id="confirm-password"
                          type={showConfirmPassword ? "text" : "password"}
                          placeholder="Confirme sua senha"
                          value={registerData.confirmPassword}
                          onChange={(e) => setRegisterData({ ...registerData, confirmPassword: e.target.value })}
                          className="pl-10 pr-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute right-3 top-3 text-gray-400 hover:text-gray-200 transition-colors"
                        >
                          {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {registerErrors.confirmPassword && (
                        <p className="text-red-400 text-xs">{registerErrors.confirmPassword}</p>
                      )}
                    </div>

                    <Button
                      type="submit"
                      className="w-full bg-orange-500 hover:bg-orange-600 text-white font-medium transition-colors shadow-soft"
                      disabled={isLoading}
                    >
                      {isLoading ? "Cadastrando..." : "Cadastrar"}
                    </Button>
                  </form>

                  <div className="mt-6 text-center">
                    <button
                      onClick={() => setCurrentView("login")}
                      className="text-sm text-gray-400 hover:text-white transition-colors"
                    >
                      ← Já tem uma conta? Faça login
                    </button>
                  </div>
                </CardContent>
              </>
            )}
          </Card>

          <div className="text-center text-xs text-gray-500">
            <p>© 2024 Atius Capital. Todos os direitos reservados.</p>
            <p className="mt-1">Seguro • Profissional • Confiável</p>
          </div>
        </div>
      </div>

      {/* Modal de Sucesso */}
      <Dialog open={showSuccessModal} onOpenChange={setShowSuccessModal}>
        <DialogContent className="bg-gray-900 border-gray-700 text-white max-w-md">
          <DialogHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center">
                <CheckCircle className="w-10 h-10 text-green-500" />
              </div>
            </div>
            <DialogTitle className="text-2xl font-bold text-white">Cadastro Efetuado</DialogTitle>
            <DialogDescription className="text-gray-400 mt-2">
              Sua conta foi criada com sucesso! Agora você já pode fazer login com suas credenciais.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center mt-6">
            <Button onClick={handleSuccessModalClose} className="bg-orange-500 hover:bg-orange-600 text-white px-8">
              Fazer Login
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal de Erro */}
      <Dialog open={showErrorModal} onOpenChange={setShowErrorModal}>
        <DialogContent className="bg-gray-900 border-gray-700 text-white max-w-md">
          <DialogHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center">
                <XCircle className="w-10 h-10 text-red-500" />
              </div>
            </div>
            <DialogTitle className="text-2xl font-bold text-white">Falha no Cadastro</DialogTitle>
            <DialogDescription className="text-gray-400 mt-2">
              Não foi possível completar seu cadastro. Verifique os dados e tente novamente.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-red-400 text-sm text-center font-medium">{errorMessage}</p>
          </div>
          <div className="flex justify-center mt-6">
            <Button
              onClick={handleErrorModalClose}
              variant="outline"
              className="border-gray-600 text-gray-300 hover:bg-gray-800 px-8"
            >
              Tentar Novamente
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
