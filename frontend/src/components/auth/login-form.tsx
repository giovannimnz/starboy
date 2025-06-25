"use client"

import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from '@/contexts/auth-context';
import { Mail, Lock, Eye, EyeOff, User, CheckCircle, XCircle } from 'lucide-react';

interface LoginFormProps {
  onLogin?: () => void;
  isLoading?: boolean;
  setIsLoading?: (loading: boolean) => void;
}

export default function LoginForm({ onLogin }: LoginFormProps) {
  const { login, register, isLoading } = useAuth();
  
  const [currentView, setCurrentView] = useState<"login" | "register" | "forgot">("login");
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Estados para login
  const [loginData, setLoginData] = useState({
    email: "",
    password: ""
  });

  // Estados para registro
  const [registerData, setRegisterData] = useState({
    firstName: "",
    email: "",
    password: "",
    confirmPassword: ""
  });

  // Estados para recuperação de senha
  const [forgotEmail, setForgotEmail] = useState("");

  // Validações
  const validateLoginForm = () => {
    if (!loginData.email || !loginData.password) {
      setErrorMessage("Por favor, preencha todos os campos.");
      setShowErrorModal(true);
      return false;
    }
    return true;
  };

  const validateRegisterForm = () => {
    if (!registerData.firstName || !registerData.email || !registerData.password || !registerData.confirmPassword) {
      setErrorMessage("Por favor, preencha todos os campos.");
      setShowErrorModal(true);
      return false;
    }

    if (registerData.password !== registerData.confirmPassword) {
      setErrorMessage("As senhas não coincidem.");
      setShowErrorModal(true);
      return false;
    }

    if (registerData.password.length < 6) {
      setErrorMessage("A senha deve ter pelo menos 6 caracteres.");
      setShowErrorModal(true);
      return false;
    }

    return true;
  };

  // Handlers
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateLoginForm()) return;

    try {
      await login(loginData.email, loginData.password);
      onLogin?.();
    } catch (error: any) {
      setErrorMessage(error.message || "Erro ao fazer login. Verifique suas credenciais.");
      setShowErrorModal(true);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateRegisterForm()) return;

    try {
      await register(registerData.firstName, registerData.email, registerData.password);
      
      // Mostrar modal de sucesso
      setShowSuccessModal(true);
      
      // Limpar formulário
      setRegisterData({
        firstName: "",
        email: "",
        password: "",
        confirmPassword: ""
      });
      
    } catch (error: any) {
      setErrorMessage(error.message || "Erro ao criar conta. Tente novamente.");
      setShowErrorModal(true);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    // Implementar recuperação de senha quando necessário
    alert(`Instruções de recuperação enviadas para ${forgotEmail}`);
    setCurrentView("login");
    setForgotEmail("");
  };

  // Modal de sucesso
  const SuccessModal = () => (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <Card className="w-full max-w-md bg-gray-900 border-gray-700">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center">
              <CheckCircle className="w-10 h-10 text-green-500" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold text-white">Cadastro Efetuado</CardTitle>
          <CardDescription className="text-gray-400 mt-2">
            Sua conta foi criada com sucesso! Agora você já pode fazer login com suas credenciais.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Button 
            onClick={() => {
              setShowSuccessModal(false);
              setCurrentView("login");
            }}
            className="w-full bg-orange-500 hover:bg-orange-600 px-8"
          >
            Fazer Login
          </Button>
        </CardContent>
      </Card>
    </div>
  );

  // Modal de erro
  const ErrorModal = () => (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <Card className="w-full max-w-md bg-gray-900 border-gray-700">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center">
              <XCircle className="w-10 h-10 text-red-500" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold text-white">Falha no Cadastro</CardTitle>
          <CardDescription className="text-gray-400 mt-2">
            Não foi possível completar a operação. Verifique os dados e tente novamente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-red-400 text-sm text-center font-medium">{errorMessage}</p>
          </div>
          <Button 
            onClick={() => setShowErrorModal(false)}
            variant="outline"
            className="w-full border-gray-600 text-gray-300 hover:bg-gray-800"
          >
            Tentar Novamente
          </Button>
        </CardContent>
      </Card>
    </div>
  );

  return (
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
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <Input
                        id="email"
                        type="email"
                        placeholder="Digite seu email"
                        value={loginData.email}
                        onChange={(e) => setLoginData({ ...loginData, email: e.target.value })}
                        className="pl-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-white">Senha</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Digite sua senha"
                        value={loginData.password}
                        onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
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
                    <Label htmlFor="forgot-email" className="text-white">Email</Label>
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
                  <div className="space-y-2">
                    <Label htmlFor="firstName" className="text-white">Nome</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <Input
                        id="firstName"
                        type="text"
                        placeholder="Seu nome"
                        maxLength={50}
                        value={registerData.firstName}
                        onChange={(e) => setRegisterData({ ...registerData, firstName: e.target.value })}
                        className="pl-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-email" className="text-white">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <Input
                        id="register-email"
                        type="email"
                        placeholder="seu@email.com"
                        value={registerData.email}
                        onChange={(e) => setRegisterData({ ...registerData, email: e.target.value })}
                        className="pl-10 bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500 focus:ring-1 focus:ring-orange-500/20"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="register-password" className="text-white">Senha</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <Input
                        id="register-password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Mínimo 6 caracteres"
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
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirm-password" className="text-white">Confirmar Senha</Label>
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

      {showSuccessModal && <SuccessModal />}
      {showErrorModal && <ErrorModal />}
    </div>
  );
}
