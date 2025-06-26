"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Upload, ChevronDown, Eye, EyeOff, Copy, Check, Plus, CheckCircle, Edit, Trash2, Loader2, TestTube2 } from "lucide-react"
import { useAuth } from "@/contexts/auth-context"
import { useLanguage } from "@/contexts/language-context"
import { api } from "@/lib/api"

interface BrokerAccount {
  id: number
  nome: string
  descricao?: string
  id_corretora: number
  nome_corretora: string
  ambiente: string
  ativa: boolean
  saldo?: number
  saldo_base_calculo?: number
  data_criacao: string
  ultima_atualizacao?: string
}

interface Broker {
  id: number
  corretora: string
  ambiente: string
  ativa: boolean
}

interface ProfileModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function ProfileModal({ isOpen, onClose }: ProfileModalProps) {
  const { user } = useAuth()
  const { t } = useLanguage()

  // Loading states
  const [isLoadingProfile, setIsLoadingProfile] = useState(false)
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false)
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false)
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false)
  const [isCreatingAccount, setIsCreatingAccount] = useState(false)
  const [isUpdatingAccount, setIsUpdatingAccount] = useState(false)
  const [isDeletingAccount, setIsDeletingAccount] = useState(false)
  const [isTestingConnection, setIsTestingConnection] = useState(false)

  // Profile form states
  const [name, setName] = useState("")
  const [lastName, setLastName] = useState("")
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  // Exchange states
  const [exchangesOpen, setExchangesOpen] = useState(false)
  const [copiedIP, setCopiedIP] = useState(false)
  const [brokerAccounts, setBrokerAccounts] = useState<BrokerAccount[]>([])
  const [availableBrokers, setAvailableBrokers] = useState<Broker[]>([])

  // Add exchange modal - CAMPOS SIMPLIFICADOS
  const [showAddExchangeModal, setShowAddExchangeModal] = useState(false)
  const [newAccountName, setNewAccountName] = useState("")
  const [newAccountApiKey, setNewAccountApiKey] = useState("")
  const [newAccountSecretKey, setNewAccountSecretKey] = useState("")

  // Success modal
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [successMessage, setSuccessMessage] = useState("")

  // Edit modal
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingAccount, setEditingAccount] = useState<BrokerAccount | null>(null)
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [editApiKey, setEditApiKey] = useState("")
  const [editSecretKey, setEditSecretKey] = useState("")

  const serverIP = "137.131.190.161"

  // Load user profile data when modal opens
  useEffect(() => {
    if (isOpen && user?.id) {
      console.log('Carregando dados para usuário ID:', user.id)
      loadUserProfile()
      loadBrokerAccounts()
      loadAvailableBrokers()
    }
  }, [isOpen, user?.id])

  const loadUserProfile = async () => {
    if (!user?.id) {
      console.error('ID do usuário não encontrado')
      alert('ID do usuário não identificado')
      return
    }

    setIsLoadingProfile(true)
    try {
      console.log('Fazendo requisição para carregar perfil do usuário:', user.id)
      
      const response = await api.getUserProfile(user.id)
      
      console.log('Resposta da API:', response)
      
      if (response.success && response.data && response.data.length > 0) {
        const userData = response.data[0]
        console.log('Dados do usuário carregados:', userData)
        
        setName(userData.nome || "")
        setLastName(userData.sobrenome || "")
        setEmail(userData.email || "")
        setUsername(userData.username || "trading_admin")
      } else {
        console.error('Resposta inválida da API:', response)
        throw new Error('Dados do usuário não encontrados')
      }
    } catch (error) {
      console.error("Erro ao carregar perfil:", error)
      alert(`Erro ao carregar dados do perfil: ${error.message}`)
    } finally {
      setIsLoadingProfile(false)
    }
  }

  const loadBrokerAccounts = async () => {
    if (!user?.id) return

    setIsLoadingAccounts(true)
    try {
      const response = await api.getUserBrokerAccounts(user.id)
      
      if (response.success) {
        setBrokerAccounts(response.data || [])
      } else {
        console.error('Erro ao carregar contas:', response)
      }
    } catch (error) {
      console.error("Erro ao carregar contas de corretora:", error)
    } finally {
      setIsLoadingAccounts(false)
    }
  }

  const loadAvailableBrokers = async () => {
    try {
      const response = await api.getAvailableBrokers()
      
      if (response.success) {
        setAvailableBrokers(response.data || [])
      } else {
        console.error('Erro ao carregar corretoras:', response)
      }
    } catch (error) {
      console.error("Erro ao carregar corretoras disponíveis:", error)
    }
  }

  const handleSaveProfile = async () => {
    if (!user?.id) {
      alert("Usuário não identificado")
      return
    }

    // Validações básicas
    if (!name.trim()) {
      alert("Nome é obrigatório")
      return
    }

    if (!email.trim()) {
      alert("Email é obrigatório")
      return
    }

    // Validação de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      alert("Digite um email válido")
      return
    }

    setIsUpdatingProfile(true)
    try {
      console.log('Atualizando perfil para usuário ID:', user.id)
      
      const userData = {
        nome: name.trim(),
        email: email.trim()
      }
      
      if (lastName.trim()) {
        userData.sobrenome = lastName.trim()
      }
      
      const response = await api.updateUserProfile(user.id, userData)
      
      console.log('Resposta da atualização de perfil:', response)
      
      if (response.success) {
        setSuccessMessage("Perfil atualizado com sucesso!")
        setShowSuccessModal(true)
      } else {
        alert(response.message || "Erro ao atualizar perfil")
      }
    } catch (error) {
      console.error("Erro ao salvar perfil:", error)
      
      const errorMessage = error.message || error.toString()
      
      if (errorMessage.includes("Este email já está sendo usado")) {
        alert("Este email já está sendo usado por outro usuário")
      } else if (errorMessage.includes("Usuário não encontrado")) {
        alert("Usuário não encontrado")
      } else {
        alert(`Erro ao salvar perfil: ${errorMessage}`)
      }
    } finally {
      setIsUpdatingProfile(false)
    }
  }

  const handleSavePassword = async () => {
    if (!user?.id) {
      alert("Usuário não identificado")
      return
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      alert("Preencha todos os campos de senha")
      return
    }

    if (newPassword !== confirmPassword) {
      alert("As senhas não coincidem")
      return
    }

    if (newPassword.length < 6) {
      alert("A nova senha deve ter pelo menos 6 caracteres")
      return
    }

    setIsUpdatingPassword(true)
    try {
      console.log('Alterando senha para usuário ID:', user.id)
      
      const response = await api.updateUserPassword(user.id, currentPassword, newPassword)
      
      console.log('Resposta da alteração de senha:', response)
      
      if (response.success) {
        setSuccessMessage("Senha alterada com sucesso!")
        setShowSuccessModal(true)
        
        setCurrentPassword("")
        setNewPassword("")
        setConfirmPassword("")
      } else {
        alert(response.message || "Erro ao alterar senha")
      }
    } catch (error) {
      console.error("Erro ao alterar senha:", error)
      
      const errorMessage = error.message || error.toString()
      
      if (errorMessage.includes("Senha atual incorreta")) {
        alert("Senha atual incorreta")
      } else if (errorMessage.includes("Usuário não encontrado")) {
        alert("Usuário não encontrado")
      } else if (errorMessage.includes("senha deve ter pelo menos 6 caracteres")) {
        alert("A nova senha deve ter pelo menos 6 caracteres")
      } else {
        alert(`Erro ao alterar senha: ${errorMessage}`)
      }
    } finally {
      setIsUpdatingPassword(false)
    }
  }

  const handleAddExchange = () => {
    // Limpar apenas os campos visíveis
    setNewAccountName("")
    setNewAccountApiKey("")
    setNewAccountSecretKey("")
    setShowAddExchangeModal(true)
  }

  const handleSaveNewAccount = async () => {
    if (!user?.id) {
      alert("Usuário não identificado")
      return
    }

    // Validar apenas os campos obrigatórios visíveis
    if (!newAccountName || !newAccountApiKey || !newAccountSecretKey) {
      alert("Preencha todos os campos obrigatórios")
      return
    }

    setIsCreatingAccount(true)
    try {
      const accountData = {
        user_id: user.id,
        nome: newAccountName.trim(),
        descricao: null, // Campo oculto - valor padrão
        id_corretora: 1, // Fixo para Binance por enquanto (primeira corretora do banco)
        api_key: newAccountApiKey.trim(),
        api_secret: newAccountSecretKey.trim(),
        ws_api_key: null, // Campo oculto - valor padrão
        ws_api_secret: null // Campo oculto - valor padrão
      }

      const response = await api.createBrokerAccount(accountData)

      if (response.success) {
        setShowAddExchangeModal(false)
        
        setSuccessMessage(`Conta "${newAccountName}" configurada com sucesso!`)
        setShowSuccessModal(true)
        
        // Recarregar lista de contas
        await loadBrokerAccounts()
      } else {
        alert(response.message || "Erro ao criar conta")
      }
    } catch (error) {
      console.error("Erro ao criar conta:", error)
      alert(`Erro ao criar conta: ${error.message}`)
    } finally {
      setIsCreatingAccount(false)
    }
  }

  const handleEditAccount = (account: BrokerAccount) => {
    setEditingAccount(account)
    setEditName(account.nome)
    setEditDescription(account.descricao || "")
    setEditApiKey("")
    setEditSecretKey("")
    setShowEditModal(true)
  }

  const handleSaveEditAccount = async () => {
    if (!editingAccount || !editName) {
      alert("Nome da conta é obrigatório")
      return
    }

    setIsUpdatingAccount(true)
    try {
      const updateData = {
        nome: editName.trim(),
        descricao: editDescription.trim() || null
      }

      if (editApiKey.trim()) {
        updateData.api_key = editApiKey.trim()
      }

      if (editSecretKey.trim()) {
        updateData.api_secret = editSecretKey.trim()
      }

      const response = await api.updateBrokerAccount(editingAccount.id, updateData)

      if (response.success) {
        setShowEditModal(false)
        setSuccessMessage(`Conta "${editName}" atualizada com sucesso!`)
        setShowSuccessModal(true)
        
        // Recarregar lista de contas
        await loadBrokerAccounts()
      } else {
        alert(response.message || "Erro ao atualizar conta")
      }
    } catch (error) {
      console.error("Erro ao atualizar conta:", error)
      alert(`Erro ao atualizar conta: ${error.message}`)
    } finally {
      setIsUpdatingAccount(false)
    }
  }

  const handleDeleteAccount = async (account: BrokerAccount) => {
    if (!confirm(`Tem certeza que deseja remover a conta "${account.nome}"?`)) {
      return
    }

    setIsDeletingAccount(true)
    try {
      const response = await api.deleteBrokerAccount(account.id)

      if (response.success) {
        setSuccessMessage(`Conta "${account.nome}" removida com sucesso!`)
        setShowSuccessModal(true)
        
        // Recarregar lista de contas
        await loadBrokerAccounts()
      } else {
        alert(response.message || "Erro ao remover conta")
      }
    } catch (error) {
      console.error("Erro ao remover conta:", error)
      alert(`Erro ao remover conta: ${error.message}`)
    } finally {
      setIsDeletingAccount(false)
    }
  }

  const handleTestConnection = async (account: BrokerAccount) => {
    setIsTestingConnection(true)
    try {
      const response = await api.testBrokerConnection(account.id)

      if (response.success) {
        setSuccessMessage(`Conexão com "${account.nome}" testada com sucesso!`)
        setShowSuccessModal(true)
      } else {
        alert(`Erro ao testar conexão: ${response.error || 'Erro desconhecido'}`)
      }
    } catch (error) {
      console.error("Erro ao testar conexão:", error)
      alert(`Erro ao testar conexão: ${error.message}`)
    } finally {
      setIsTestingConnection(false)
    }
  }

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      console.log("Uploading file:", file.name)
      alert("Foto de perfil atualizada!")
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedIP(true)
    setTimeout(() => setCopiedIP(false), 2000)
  }

  const getBrokerIcon = (brokerName: string) => {
    const icons = {
      'binance': { icon: 'B', color: 'bg-yellow-500' },
      'mexc': { icon: 'M', color: 'bg-blue-500' },
      'okx': { icon: 'O', color: 'bg-green-500' }
    }
    return icons[brokerName.toLowerCase()] || { icon: 'C', color: 'bg-gray-500' }
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-gray-900 border-gray-700">
          <DialogHeader>
            <DialogTitle className="text-white text-xl">Configurações do Perfil</DialogTitle>
            <DialogDescription className="text-gray-400">
              Gerencie suas informações pessoais e configurações de corretoras
            </DialogDescription>
          </DialogHeader>

          {isLoadingProfile ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
              <span className="ml-2 text-white">Carregando dados do perfil...</span>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Profile Section */}
              <Card className="bg-gray-800 border-gray-700">
                <CardHeader>
                  <CardTitle className="text-white">Informações Pessoais</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Profile Picture */}
                  <div className="flex items-center space-x-4">
                    <Avatar className="h-20 w-20">
                      <AvatarImage src="/placeholder.svg?height=80&width=80" alt={name} />
                      <AvatarFallback className="bg-orange-500 text-white text-xl">
                        {name?.charAt(0) || ""}
                        {lastName?.charAt(0) || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <Label htmlFor="profile-picture" className="cursor-pointer">
                        <Button variant="outline" className="border-gray-600 text-gray-300 hover:bg-gray-700">
                          <Upload className="h-4 w-4 mr-2" />
                          Alterar Foto
                        </Button>
                      </Label>
                      <input
                        id="profile-picture"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleFileUpload}
                      />
                      <p className="text-xs text-gray-500 mt-1">JPG, PNG ou GIF (máx. 2MB)</p>
                    </div>
                  </div>

                  {/* Form Fields */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="name" className="text-white">
                        Nome *
                      </Label>
                      <Input
                        id="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                        disabled={isLoadingProfile || isUpdatingProfile}
                        placeholder="Digite seu nome"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lastName" className="text-white">
                        Sobrenome
                      </Label>
                      <Input
                        id="lastName"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                        disabled={isLoadingProfile || isUpdatingProfile}
                        placeholder="Digite seu sobrenome"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="username" className="text-white">
                        Usuário
                      </Label>
                      <Input
                        id="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                        disabled={true}
                        title="Campo somente leitura"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white">
                      Email *
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                      disabled={isLoadingProfile || isUpdatingProfile}
                      placeholder="Digite seu email"
                    />
                  </div>

                  <Button 
                    onClick={handleSaveProfile} 
                    className="bg-orange-500 hover:bg-orange-600 text-white"
                    disabled={isLoadingProfile || isUpdatingProfile || !name.trim() || !email.trim()}
                  >
                    {isUpdatingProfile ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Salvando...
                      </>
                    ) : (
                      "Salvar Perfil"
                    )}
                  </Button>
                </CardContent>
              </Card>

              {/* Password Change Section */}
              <Card className="bg-gray-800 border-gray-700">
                <CardHeader>
                  <CardTitle className="text-white">Alterar Senha</CardTitle>
                  <CardDescription className="text-gray-400">
                    Altere sua senha de acesso ao sistema
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="current-password" className="text-white">
                        Senha Atual *
                      </Label>
                      <div className="relative">
                        <Input
                          id="current-password"
                          type={showCurrentPassword ? "text" : "password"}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          className="bg-gray-700 border-gray-600 text-white focus:border-orange-500 pr-10"
                          disabled={isUpdatingPassword}
                        />
                        <button
                          type="button"
                          onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-200"
                          disabled={isUpdatingPassword}
                        >
                          {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="new-password" className="text-white">
                          Nova Senha *
                        </Label>
                        <div className="relative">
                          <Input
                            id="new-password"
                            type={showNewPassword ? "text" : "password"}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500 pr-10"
                            disabled={isUpdatingPassword}
                            minLength={6}
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-200"
                            disabled={isUpdatingPassword}
                          >
                            {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        <p className="text-xs text-gray-500">Mínimo de 6 caracteres</p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="confirm-password" className="text-white">
                          Confirmar Nova Senha *
                        </Label>
                        <div className="relative">
                          <Input
                            id="confirm-password"
                            type={showConfirmPassword ? "text" : "password"}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500 pr-10"
                            disabled={isUpdatingPassword}
                          />
                          <button
                            type="button"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-200"
                            disabled={isUpdatingPassword}
                          >
                            {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <Button 
                    onClick={handleSavePassword} 
                    className="bg-orange-500 hover:bg-orange-600 text-white"
                    disabled={isUpdatingPassword || !currentPassword || !newPassword || !confirmPassword}
                  >
                    {isUpdatingPassword ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Alterando Senha...
                      </>
                    ) : (
                      "Alterar Senha"
                    )}
                  </Button>
                </CardContent>
              </Card>

              {/* Exchange Configurations */}
              <div className="space-y-4">
                <h3 className="text-white text-lg font-semibold">Configurações de Corretoras</h3>

                {/* IP Information */}
                <Card className="bg-gray-800 border-gray-700">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-medium">IP do Servidor</p>
                        <p className="text-gray-400 text-sm">Use este IP na whitelist das suas corretoras</p>
                      </div>
                      <div className="flex items-center space-x-2">
                        <code className="bg-gray-700 text-orange-400 px-3 py-1 rounded font-mono">{serverIP}</code>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyToClipboard(serverIP)}
                          className="border-gray-600 text-gray-300 hover:bg-gray-700"
                        >
                          {copiedIP ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Broker Accounts Configuration */}
                <Collapsible open={exchangesOpen} onOpenChange={setExchangesOpen}>
                  <Card className="bg-gray-800 border-gray-700">
                    <CollapsibleTrigger asChild>
                      <CardHeader className="cursor-pointer hover:bg-gray-750 transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 bg-orange-500 rounded flex items-center justify-center">
                              <span className="text-white font-bold text-sm">C</span>
                            </div>
                            <div>
                              <CardTitle className="text-white">Contas de Corretoras</CardTitle>
                              <CardDescription>
                                {isLoadingAccounts 
                                  ? "Carregando contas..."
                                  : brokerAccounts.length === 0
                                  ? "Nenhuma conta configurada"
                                  : `${brokerAccounts.length} conta(s) configurada(s)`}
                              </CardDescription>
                            </div>
                            {brokerAccounts.length > 0 && (
                              <div className="flex items-center space-x-2">
                                <CheckCircle className="h-5 w-5 text-green-500" />
                                <div className="flex space-x-1">
                                  {Array.from(new Set(brokerAccounts.map(acc => acc.nome_corretora))).map((brokerName, index) => {
                                    const brokerInfo = getBrokerIcon(brokerName)
                                    return (
                                      <div
                                        key={index}
                                        className={`w-6 h-6 ${brokerInfo.color} rounded flex items-center justify-center`}
                                      >
                                        <span className="text-white font-bold text-xs">{brokerInfo.icon}</span>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                          <ChevronDown
                            className={`h-5 w-5 text-gray-400 transition-transform ${exchangesOpen ? "rotate-180" : ""}`}
                          />
                        </div>
                      </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent className="space-y-4">
                        {/* Loading state */}
                        {isLoadingAccounts && (
                          <div className="flex items-center justify-center py-4">
                            <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
                            <span className="ml-2 text-white">Carregando contas...</span>
                          </div>
                        )}

                        {/* Configured Accounts */}
                        {!isLoadingAccounts && brokerAccounts.length > 0 && (
                          <div className="space-y-3">
                            <h4 className="text-white font-medium">Contas Configuradas</h4>
                            {brokerAccounts.map((account) => {
                              const brokerInfo = getBrokerIcon(account.nome_corretora)
                              return (
                                <div
                                  key={account.id}
                                  className="flex items-center justify-between p-3 bg-gray-700 rounded-lg border border-gray-600"
                                >
                                  <div className="flex items-center space-x-3">
                                    <div
                                      className={`w-8 h-8 ${brokerInfo.color} rounded flex items-center justify-center`}
                                    >
                                      <span className="text-white font-bold text-sm">{brokerInfo.icon}</span>
                                    </div>
                                    <div>
                                      <div className="text-white font-medium">{account.nome}</div>
                                      <div className="text-gray-400 text-sm">
                                        {account.nome_corretora} ({account.ambiente.toUpperCase()})
                                      </div>
                                      {account.saldo !== undefined && (
                                        <div className="text-orange-400 text-sm">
                                          Saldo: ${Number(account.saldo).toFixed(2).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </div>
                                      )}
                                    </div>
                                    <CheckCircle className="h-4 w-4 text-green-500" />
                                  </div>
                                  <div className="flex items-center space-x-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleTestConnection(account)}
                                      className="border-green-600 text-green-400 hover:bg-green-600/10"
                                      disabled={isTestingConnection}
                                    >
                                      {isTestingConnection ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <TestTube2 className="h-3 w-3" />
                                      )}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleEditAccount(account)}
                                      className="border-gray-600 text-gray-300 hover:bg-gray-600"
                                      disabled={isUpdatingAccount}
                                    >
                                      <Edit className="h-3 w-3" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => handleDeleteAccount(account)}
                                      className="border-red-600 text-red-400 hover:bg-red-600/10"
                                      disabled={isDeletingAccount}
                                    >
                                      {isDeletingAccount ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <Trash2 className="h-3 w-3" />
                                      )}
                                    </Button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}

                        {/* Add New Account Button */}
                        <div className="border-t border-gray-700 pt-4">
                          <Button
                            onClick={handleAddExchange}
                            className="w-full bg-orange-500 hover:bg-orange-600 text-white"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Adicionar Nova Corretora
                          </Button>
                        </div>
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* MODAL SIMPLIFICADO - Adicionar Nova Corretora */}
      <Dialog open={showAddExchangeModal} onOpenChange={setShowAddExchangeModal}>
        <DialogContent className="max-w-md bg-gray-900 border-gray-700">
          <DialogHeader>
            <DialogTitle className="text-white">Adicionar Nova Corretora</DialogTitle>
            <DialogDescription className="text-gray-400">
              Configure sua conta da Binance
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Campo: Nome da Conta */}
            <div className="space-y-2">
              <Label htmlFor="new-account-name" className="text-white">
                Nome da Conta *
              </Label>
              <Input
                id="new-account-name"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Ex: Conta Principal"
                disabled={isCreatingAccount}
              />
            </div>

            {/* Campo: API Key */}
            <div className="space-y-2">
              <Label htmlFor="new-api-key" className="text-white">
                API Key *
              </Label>
              <Input
                id="new-api-key"
                value={newAccountApiKey}
                onChange={(e) => setNewAccountApiKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Sua API Key da Binance"
                disabled={isCreatingAccount}
              />
            </div>

            {/* Campo: Secret Key */}
            <div className="space-y-2">
              <Label htmlFor="new-secret-key" className="text-white">
                Secret Key *
              </Label>
              <Input
                id="new-secret-key"
                type="password"
                value={newAccountSecretKey}
                onChange={(e) => setNewAccountSecretKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Sua Secret Key da Binance"
                disabled={isCreatingAccount}
              />
            </div>

            {/* Informação sobre Whitelist */}
            <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-3">
              <p className="text-orange-400 text-sm">
                <strong>Importante:</strong> Adicione o IP {serverIP} na whitelist da sua API key na Binance.
              </p>
            </div>
          </div>

          <div className="flex justify-end space-x-3 mt-6">
            <Button
              variant="outline"
              onClick={() => setShowAddExchangeModal(false)}
              className="border-gray-600 text-gray-300 hover:bg-gray-700"
              disabled={isCreatingAccount}
            >
              Cancelar
            </Button>
            <Button 
              onClick={handleSaveNewAccount} 
              className="bg-orange-500 hover:bg-orange-600 text-white"
              disabled={isCreatingAccount || !newAccountName || !newAccountApiKey || !newAccountSecretKey}
            >
              {isCreatingAccount ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Criando...
                </>
              ) : (
                "Salvar Configurações"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Account Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <DialogContent className="max-w-md bg-gray-900 border-gray-700">
          <DialogHeader>
            <DialogTitle className="text-white">Editar Conta</DialogTitle>
            <DialogDescription className="text-gray-400">Atualize as configurações da sua conta</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name" className="text-white">
                Nome da Conta
              </Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-description" className="text-white">
                Descrição (opcional)
              </Label>
              <Input
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-api-key" className="text-white">
                Nova API Key (opcional)
              </Label>
              <Input
                id="edit-api-key"
                value={editApiKey}
                onChange={(e) => setEditApiKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Deixe em branco para manter a atual"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-secret-key" className="text-white">
                Nova Secret Key (opcional)
              </Label>
              <Input
                id="edit-secret-key"
                type="password"
                value={editSecretKey}
                onChange={(e) => setEditSecretKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Deixe em branco para manter a atual"
              />
              <p className="text-xs text-gray-500">
                Por segurança, as chaves atuais não são exibidas. Preencha apenas se desejar alterá-las.
              </p>
            </div>
          </div>

          <div className="flex justify-end space-x-3 mt-6">
            <Button
              variant="outline"
              onClick={() => setShowEditModal(false)}
              className="border-gray-600 text-gray-300 hover:bg-gray-700"
            >
              Cancelar
            </Button>
            <Button onClick={handleSaveEditAccount} className="bg-orange-500 hover:bg-orange-600 text-white">
              Salvar Alterações
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Success Modal */}
      <Dialog open={showSuccessModal} onOpenChange={setShowSuccessModal}>
        <DialogContent className="bg-gray-900 border-gray-700 text-white max-w-md">
          <DialogHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center">
                <CheckCircle className="w-10 h-10 text-green-500" />
              </div>
            </div>
            <DialogTitle className="text-2xl font-bold text-white">Operação Realizada</DialogTitle>
            <DialogDescription className="text-gray-400 mt-2">{successMessage}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-center mt-6">
            <Button
              onClick={() => setShowSuccessModal(false)}
              className="bg-orange-500 hover:bg-orange-600 text-white px-8"
            >
              Continuar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
