"use client"

import type React from "react"

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Upload, ChevronDown, Eye, EyeOff, Copy, Check, Plus, CheckCircle, Edit, Trash2 } from "lucide-react"
import { useAuth } from "@/contexts/auth-context"
import { useLanguage } from "@/contexts/language-context"

interface ExchangeAccount {
  id: string
  exchange: string
  nickname: string
  apiKey: string
  secretKey: string
  createdAt: Date
}

interface ProfileModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function ProfileModal({ isOpen, onClose }: ProfileModalProps) {
  const { user } = useAuth()
  const { t } = useLanguage()

  // Profile form states
  const [name, setName] = useState(user?.name || "")
  const [username, setUsername] = useState("trading_admin")
  const [email, setEmail] = useState(user?.email || "")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  // Exchange states
  const [exchangesOpen, setExchangesOpen] = useState(false)
  const [copiedIP, setCopiedIP] = useState(false)
  const [configuredAccounts, setConfiguredAccounts] = useState<ExchangeAccount[]>([])

  // Add exchange modal
  const [showAddExchangeModal, setShowAddExchangeModal] = useState(false)
  const [selectedExchange, setSelectedExchange] = useState("")
  const [newAccountNickname, setNewAccountNickname] = useState("")
  const [newAccountApiKey, setNewAccountApiKey] = useState("")
  const [newAccountSecretKey, setNewAccountSecretKey] = useState("")

  // Success modal
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [successMessage, setSuccessMessage] = useState("")

  // Edit modal
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingAccount, setEditingAccount] = useState<ExchangeAccount | null>(null)
  const [editNickname, setEditNickname] = useState("")
  const [editApiKey, setEditApiKey] = useState("")
  const [editSecretKey, setEditSecretKey] = useState("")

  const serverIP = "137.131.190.161"

  // Available exchanges
  const availableExchanges = [
    { value: "binance", label: "Binance", icon: "B", color: "bg-yellow-500" },
    // { value: "mexc", label: "MEXC", icon: "M", color: "bg-blue-500", disabled: true },
  ]

  const handleSaveProfile = () => {
    // Validate passwords if changing
    if (newPassword && newPassword !== confirmPassword) {
      alert("As senhas não coincidem")
      return
    }

    console.log("Saving profile:", { name, username, email })
    if (newPassword) {
      console.log("Changing password")
    }

    // Here you would make API calls to save the data
    alert("Perfil salvo com sucesso!")
  }

  const handleAddExchange = () => {
    setSelectedExchange("")
    setNewAccountNickname("")
    setNewAccountApiKey("")
    setNewAccountSecretKey("")
    setShowAddExchangeModal(true)
  }

  const handleSaveNewAccount = () => {
    if (!selectedExchange || !newAccountNickname || !newAccountApiKey || !newAccountSecretKey) {
      alert("Preencha todos os campos obrigatórios")
      return
    }

    const newAccount: ExchangeAccount = {
      id: Date.now().toString(),
      exchange: selectedExchange,
      nickname: newAccountNickname,
      apiKey: newAccountApiKey,
      secretKey: newAccountSecretKey,
      createdAt: new Date(),
    }

    setConfiguredAccounts([...configuredAccounts, newAccount])
    setShowAddExchangeModal(false)

    // Show success modal
    const exchangeLabel = availableExchanges.find((ex) => ex.value === selectedExchange)?.label || selectedExchange
    setSuccessMessage(`Conta ${exchangeLabel} "${newAccountNickname}" configurada com sucesso!`)
    setShowSuccessModal(true)

    console.log("New account added:", newAccount)
  }

  const handleEditAccount = (account: ExchangeAccount) => {
    setEditingAccount(account)
    setEditNickname(account.nickname)
    setEditApiKey(account.apiKey)
    setEditSecretKey("")
    setShowEditModal(true)
  }

  const handleSaveEditAccount = () => {
    if (!editingAccount || !editNickname || !editApiKey) {
      alert("Preencha todos os campos obrigatórios")
      return
    }

    const updatedAccounts = configuredAccounts.map((account) =>
      account.id === editingAccount.id
        ? {
            ...account,
            nickname: editNickname,
            apiKey: editApiKey,
            secretKey: editSecretKey || account.secretKey,
          }
        : account,
    )

    setConfiguredAccounts(updatedAccounts)
    setShowEditModal(false)

    const exchangeLabel =
      availableExchanges.find((ex) => ex.value === editingAccount.exchange)?.label || editingAccount.exchange
    setSuccessMessage(`Conta ${exchangeLabel} "${editNickname}" atualizada com sucesso!`)
    setShowSuccessModal(true)
  }

  const handleDeleteAccount = (accountId: string) => {
    if (confirm("Tem certeza que deseja remover esta conta?")) {
      setConfiguredAccounts(configuredAccounts.filter((account) => account.id !== accountId))
    }
  }

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      console.log("Uploading file:", file.name)
      // Here you would handle the file upload
      alert("Foto de perfil atualizada!")
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedIP(true)
    setTimeout(() => setCopiedIP(false), 2000)
  }

  const getExchangeInfo = (exchangeValue: string) => {
    return availableExchanges.find((ex) => ex.value === exchangeValue)
  }

  const getConfiguredExchanges = () => {
    const exchanges = [...new Set(configuredAccounts.map((account) => account.exchange))]
    return exchanges.map((exchange) => getExchangeInfo(exchange)).filter(Boolean)
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
                      {name?.charAt(0) || "U"}
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
                      Nome
                    </Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="username" className="text-white">
                      Usuário
                    </Label>
                    <Input
                      id="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email" className="text-white">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                  />
                </div>

                {/* Password Change Section */}
                <div className="border-t border-gray-700 pt-4">
                  <h4 className="text-white font-medium mb-3">Alterar Senha</h4>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="current-password" className="text-white">
                        Senha Atual
                      </Label>
                      <div className="relative">
                        <Input
                          id="current-password"
                          type={showCurrentPassword ? "text" : "password"}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          className="bg-gray-700 border-gray-600 text-white focus:border-orange-500 pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-200"
                        >
                          {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="new-password" className="text-white">
                          Nova Senha
                        </Label>
                        <div className="relative">
                          <Input
                            id="new-password"
                            type={showNewPassword ? "text" : "password"}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500 pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-200"
                          >
                            {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="confirm-password" className="text-white">
                          Confirmar Nova Senha
                        </Label>
                        <div className="relative">
                          <Input
                            id="confirm-password"
                            type={showConfirmPassword ? "text" : "password"}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500 pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-200"
                          >
                            {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <Button onClick={handleSaveProfile} className="bg-orange-500 hover:bg-orange-600 text-white">
                  Salvar Perfil
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

              {/* Exchanges Configuration */}
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
                            <CardTitle className="text-white">Configurações de Corretoras</CardTitle>
                            <CardDescription>
                              {configuredAccounts.length === 0
                                ? "Configure suas contas de corretoras"
                                : `${configuredAccounts.length} conta(s) configurada(s)`}
                            </CardDescription>
                          </div>
                          {configuredAccounts.length > 0 && (
                            <div className="flex items-center space-x-2">
                              <CheckCircle className="h-5 w-5 text-green-500" />
                              <div className="flex space-x-1">
                                {getConfiguredExchanges().map((exchange, index) => (
                                  <div
                                    key={index}
                                    className={`w-6 h-6 ${exchange?.color} rounded flex items-center justify-center`}
                                  >
                                    <span className="text-white font-bold text-xs">{exchange?.icon}</span>
                                  </div>
                                ))}
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
                      {/* Configured Accounts */}
                      {configuredAccounts.length > 0 && (
                        <div className="space-y-3">
                          <h4 className="text-white font-medium">Contas Configuradas</h4>
                          {configuredAccounts.map((account) => {
                            const exchangeInfo = getExchangeInfo(account.exchange)
                            return (
                              <div
                                key={account.id}
                                className="flex items-center justify-between p-3 bg-gray-700 rounded-lg border border-gray-600"
                              >
                                <div className="flex items-center space-x-3">
                                  <div
                                    className={`w-8 h-8 ${exchangeInfo?.color} rounded flex items-center justify-center`}
                                  >
                                    <span className="text-white font-bold text-sm">{exchangeInfo?.icon}</span>
                                  </div>
                                  <div>
                                    <div className="text-white font-medium">{account.nickname}</div>
                                    <div className="text-gray-400 text-sm">{exchangeInfo?.label}</div>
                                  </div>
                                  <CheckCircle className="h-4 w-4 text-green-500" />
                                </div>
                                <div className="flex items-center space-x-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleEditAccount(account)}
                                    className="border-gray-600 text-gray-300 hover:bg-gray-600"
                                  >
                                    <Edit className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleDeleteAccount(account.id)}
                                    className="border-red-600 text-red-400 hover:bg-red-600/10"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Add New Exchange Button */}
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
        </DialogContent>
      </Dialog>

      {/* Add Exchange Modal */}
      <Dialog open={showAddExchangeModal} onOpenChange={setShowAddExchangeModal}>
        <DialogContent className="max-w-md bg-gray-900 border-gray-700">
          <DialogHeader>
            <DialogTitle className="text-white">Adicionar Nova Corretora</DialogTitle>
            <DialogDescription className="text-gray-400">Configure uma nova conta de corretora</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="exchange-select" className="text-white">
                Corretora
              </Label>
              <Select value={selectedExchange} onValueChange={setSelectedExchange}>
                <SelectTrigger className="bg-gray-700 border-gray-600 text-white focus:border-orange-500">
                  <SelectValue placeholder="Selecione a corretora" />
                </SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-600">
                  {availableExchanges.map((exchange) => (
                    <SelectItem
                      key={exchange.value}
                      value={exchange.value}
                      disabled={exchange.disabled}
                      className="text-white hover:bg-gray-700 focus:bg-gray-700"
                    >
                      <div className="flex items-center space-x-2">
                        <div className={`w-6 h-6 ${exchange.color} rounded flex items-center justify-center`}>
                          <span className="text-white font-bold text-xs">{exchange.icon}</span>
                        </div>
                        <span>{exchange.label}</span>
                        {exchange.disabled && <span className="text-gray-500 text-xs">(Em breve)</span>}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-nickname" className="text-white">
                Apelido
              </Label>
              <Input
                id="new-nickname"
                value={newAccountNickname}
                onChange={(e) => setNewAccountNickname(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Ex: Conta Principal"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-api-key" className="text-white">
                API Key
              </Label>
              <Input
                id="new-api-key"
                value={newAccountApiKey}
                onChange={(e) => setNewAccountApiKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Sua API Key"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-secret-key" className="text-white">
                Secret Key
              </Label>
              <Input
                id="new-secret-key"
                type="password"
                value={newAccountSecretKey}
                onChange={(e) => setNewAccountSecretKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Sua Secret Key"
              />
            </div>
          </div>

          <div className="flex justify-end space-x-3 mt-6">
            <Button
              variant="outline"
              onClick={() => setShowAddExchangeModal(false)}
              className="border-gray-600 text-gray-300 hover:bg-gray-700"
            >
              Cancelar
            </Button>
            <Button onClick={handleSaveNewAccount} className="bg-orange-500 hover:bg-orange-600 text-white">
              Salvar Configurações
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
              <Label htmlFor="edit-nickname" className="text-white">
                Apelido
              </Label>
              <Input
                id="edit-nickname"
                value={editNickname}
                onChange={(e) => setEditNickname(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-api-key" className="text-white">
                API Key
              </Label>
              <Input
                id="edit-api-key"
                value={editApiKey}
                onChange={(e) => setEditApiKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
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
                Por segurança, a Secret Key atual não é exibida. Preencha apenas se desejar alterá-la.
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
            <DialogTitle className="text-2xl font-bold text-white">Cadastro Efetuado</DialogTitle>
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
