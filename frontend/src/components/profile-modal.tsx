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
import { Upload, ChevronDown, Eye, EyeOff, Copy, Check, Edit, CheckCircle } from "lucide-react"
import { useAuth } from "@/contexts/auth-context"
import { useLanguage } from "@/contexts/language-context"

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
  const [binanceOpen, setBinanceOpen] = useState(false)
  const [mexcOpen, setMexcOpen] = useState(false)
  const [copiedIP, setCopiedIP] = useState(false)

  // Binance config
  const [binanceConfigured, setBinanceConfigured] = useState(false)
  const [binanceNickname, setBinanceNickname] = useState("")
  const [binanceApiKey, setBinanceApiKey] = useState("")
  const [binanceSecretKey, setBinanceSecretKey] = useState("")

  // Binance edit modal
  const [showBinanceEditModal, setShowBinanceEditModal] = useState(false)
  const [editBinanceNickname, setEditBinanceNickname] = useState("")
  const [editBinanceApiKey, setEditBinanceApiKey] = useState("")
  const [editBinanceSecretKey, setEditBinanceSecretKey] = useState("")

  // MEXC config
  const [mexcNickname, setMexcNickname] = useState("")
  const [mexcApiKey, setMexcApiKey] = useState("")
  const [mexcSecretKey, setMexcSecretKey] = useState("")

  const serverIP = "137.131.190.161"

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

  const handleSaveBinance = () => {
    if (!binanceNickname || !binanceApiKey || !binanceSecretKey) {
      alert("Preencha todos os campos obrigatórios")
      return
    }

    console.log("Saving Binance config:", { binanceNickname, binanceApiKey, binanceSecretKey })

    // Mark as configured and close collapsible
    setBinanceConfigured(true)
    setBinanceOpen(false)

    alert("Configurações da Binance salvas com sucesso!")
  }

  const handleEditBinance = () => {
    // Populate edit form with current data
    setEditBinanceNickname(binanceNickname)
    setEditBinanceApiKey(binanceApiKey)
    setEditBinanceSecretKey("") // Don't show current secret key
    setShowBinanceEditModal(true)
  }

  const handleSaveBinanceEdit = () => {
    if (!editBinanceNickname || !editBinanceApiKey) {
      alert("Preencha todos os campos obrigatórios")
      return
    }

    // Update the main state
    setBinanceNickname(editBinanceNickname)
    setBinanceApiKey(editBinanceApiKey)

    // Only update secret key if provided
    if (editBinanceSecretKey) {
      setBinanceSecretKey(editBinanceSecretKey)
    }

    console.log("Updating Binance config:", {
      nickname: editBinanceNickname,
      apiKey: editBinanceApiKey,
      secretKey: editBinanceSecretKey || "unchanged",
    })

    setShowBinanceEditModal(false)
    alert("Configurações da Binance atualizadas com sucesso!")
  }

  const handleSaveMexc = () => {
    console.log("Saving MEXC config:", { mexcNickname, mexcApiKey, mexcSecretKey })
    alert("Configurações da MEXC salvas!")
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

              {/* Binance Configuration */}
              {!binanceConfigured ? (
                <Collapsible open={binanceOpen} onOpenChange={setBinanceOpen}>
                  <Card className="bg-gray-800 border-gray-700">
                    <CollapsibleTrigger asChild>
                      <CardHeader className="cursor-pointer hover:bg-gray-750 transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 bg-yellow-500 rounded flex items-center justify-center">
                              <span className="text-black font-bold text-sm">B</span>
                            </div>
                            <div>
                              <CardTitle className="text-white">Binance</CardTitle>
                              <CardDescription>Configure sua conta Binance</CardDescription>
                            </div>
                          </div>
                          <ChevronDown
                            className={`h-5 w-5 text-gray-400 transition-transform ${binanceOpen ? "rotate-180" : ""}`}
                          />
                        </div>
                      </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="binance-nickname" className="text-white">
                            Apelido
                          </Label>
                          <Input
                            id="binance-nickname"
                            value={binanceNickname}
                            onChange={(e) => setBinanceNickname(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                            placeholder="Ex: Conta Principal"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="binance-api-key" className="text-white">
                            API Key
                          </Label>
                          <Input
                            id="binance-api-key"
                            value={binanceApiKey}
                            onChange={(e) => setBinanceApiKey(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                            placeholder="Sua API Key da Binance"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="binance-secret-key" className="text-white">
                            Secret Key
                          </Label>
                          <Input
                            id="binance-secret-key"
                            type="password"
                            value={binanceSecretKey}
                            onChange={(e) => setBinanceSecretKey(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                            placeholder="Sua Secret Key da Binance"
                          />
                        </div>
                        <Button onClick={handleSaveBinance} className="bg-orange-500 hover:bg-orange-600 text-white">
                          Salvar Configurações Binance
                        </Button>
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              ) : (
                <Card className="bg-gray-800 border-gray-700">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 bg-yellow-500 rounded flex items-center justify-center">
                          <span className="text-black font-bold text-sm">B</span>
                        </div>
                        <div className="flex items-center space-x-3">
                          <div>
                            <CardTitle className="text-white">Binance</CardTitle>
                            <CardDescription>{binanceNickname}</CardDescription>
                          </div>
                          <div className="flex items-center space-x-2">
                            <CheckCircle className="h-5 w-5 text-green-500" />
                            <span className="text-green-500 text-sm font-medium">Conta Vinculada</span>
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleEditBinance}
                        className="border-gray-600 text-gray-300 hover:bg-gray-700"
                      >
                        <Edit className="h-4 w-4 mr-2" />
                        Editar
                      </Button>
                    </div>
                  </CardHeader>
                </Card>
              )}

              {/* MEXC Configuration - Coming Soon */}
              <div className="relative">
                <Collapsible open={mexcOpen} onOpenChange={setMexcOpen} disabled>
                  <Card className="bg-gray-800 border-gray-700 opacity-50 blur-sm pointer-events-none">
                    <CollapsibleTrigger asChild>
                      <CardHeader className="cursor-not-allowed">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 bg-blue-500 rounded flex items-center justify-center">
                              <span className="text-white font-bold text-sm">M</span>
                            </div>
                            <div>
                              <CardTitle className="text-white">MEXC</CardTitle>
                              <CardDescription>Configure sua conta MEXC</CardDescription>
                            </div>
                          </div>
                          <ChevronDown
                            className={`h-5 w-5 text-gray-400 transition-transform ${mexcOpen ? "rotate-180" : ""}`}
                          />
                        </div>
                      </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="mexc-nickname" className="text-white">
                            Apelido
                          </Label>
                          <Input
                            id="mexc-nickname"
                            value={mexcNickname}
                            onChange={(e) => setMexcNickname(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                            placeholder="Ex: Conta Secundária"
                            disabled
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mexc-api-key" className="text-white">
                            API Key
                          </Label>
                          <Input
                            id="mexc-api-key"
                            value={mexcApiKey}
                            onChange={(e) => setMexcApiKey(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                            placeholder="Sua API Key da MEXC"
                            disabled
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mexc-secret-key" className="text-white">
                            Secret Key
                          </Label>
                          <Input
                            id="mexc-secret-key"
                            type="password"
                            value={mexcSecretKey}
                            onChange={(e) => setMexcSecretKey(e.target.value)}
                            className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                            placeholder="Sua Secret Key da MEXC"
                            disabled
                          />
                        </div>
                        <Button disabled className="bg-orange-500 hover:bg-orange-600 text-white opacity-50">
                          Salvar Configurações MEXC
                        </Button>
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>

                {/* Coming Soon Overlay */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="bg-gray-900/90 backdrop-blur-sm px-6 py-3 rounded-lg border border-gray-600">
                    <span className="text-white font-semibold text-lg">Em breve...</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Binance Edit Modal */}
      <Dialog open={showBinanceEditModal} onOpenChange={setShowBinanceEditModal}>
        <DialogContent className="max-w-md bg-gray-900 border-gray-700">
          <DialogHeader>
            <DialogTitle className="text-white">Editar Configurações Binance</DialogTitle>
            <DialogDescription className="text-gray-400">Atualize suas configurações da API Binance</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-binance-nickname" className="text-white">
                Apelido
              </Label>
              <Input
                id="edit-binance-nickname"
                value={editBinanceNickname}
                onChange={(e) => setEditBinanceNickname(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Ex: Conta Principal"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-binance-api-key" className="text-white">
                API Key
              </Label>
              <Input
                id="edit-binance-api-key"
                value={editBinanceApiKey}
                onChange={(e) => setEditBinanceApiKey(e.target.value)}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                placeholder="Sua API Key da Binance"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-binance-secret-key" className="text-white">
                Nova Secret Key (opcional)
              </Label>
              <Input
                id="edit-binance-secret-key"
                type="password"
                value={editBinanceSecretKey}
                onChange={(e) => setEditBinanceSecretKey(e.target.value)}
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
              onClick={() => setShowBinanceEditModal(false)}
              className="border-gray-600 text-gray-300 hover:bg-gray-700"
            >
              Cancelar
            </Button>
            <Button onClick={handleSaveBinanceEdit} className="bg-orange-500 hover:bg-orange-600 text-white">
              Salvar Alterações
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
