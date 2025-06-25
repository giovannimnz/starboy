"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { RefreshCw, User, Globe, HelpCircle, LogOut, ChevronDown, Check } from "lucide-react"
import { useAuth } from "@/contexts/auth-context"
import { useLanguage } from "@/contexts/language-context"
import ProfileModal from "./profile-modal"

interface UserMenuProps {
  balance: {
    usd: number
    btc: number
  }
  currentPrice: number
  onAccountChange?: (account: string) => void
}

export default function UserMenu({ balance, currentPrice, onAccountChange }: UserMenuProps) {
  const { user, logout } = useAuth()
  const { language, setLanguage, t } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState("binance.futures")
  const [showLanguages, setShowLanguages] = useState(false)
  const [showProfileModal, setShowProfileModal] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const portfolioValue = balance.usd + balance.btc * currentPrice

  const accounts = [
    { key: "binance.spot", label: t("binance.spot") },
    { key: "binance.futures", label: t("binance.futures") },
  ]

  const languages = [
    { key: "pt", label: t("portuguese") },
    { key: "en", label: t("english") },
    { key: "es", label: t("spanish") },
  ]

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setShowLanguages(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  const handleRefreshBalance = async () => {
    setIsRefreshing(true)
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 1000))
    setIsRefreshing(false)
  }

  const handleAccountChange = (accountKey: string) => {
    setSelectedAccount(accountKey)
    onAccountChange?.(accountKey)
  }

  const handleLanguageChange = (langKey: string) => {
    setLanguage(langKey as "pt" | "en" | "es")
    setShowLanguages(false)
    setIsOpen(false)
  }

  const handleMenuAction = (action: string) => {
    if (action === "language") {
      setShowLanguages(!showLanguages)
      return
    }

    if (action === "profile") {
      setShowProfileModal(true)
      setIsOpen(false)
      setShowLanguages(false)
      return
    }

    console.log(`Action: ${action}`)
    setIsOpen(false)
    setShowLanguages(false)

    if (action === "logout") {
      logout()
    }
  }

  return (
    <>
      <div className="relative" ref={menuRef}>
        {/* Trigger Button */}
        <Button
          variant="outline"
          className="flex items-center space-x-3 p-3 h-auto bg-background hover:bg-accent border-border shadow-soft hover:shadow-soft-md transition-all duration-200"
          onClick={() => setIsOpen(!isOpen)}
        >
          <Avatar className="h-8 w-8 shadow-soft">
            <AvatarImage src="/placeholder.svg?height=32&width=32" alt={user?.name} />
            <AvatarFallback className="bg-primary text-primary-foreground text-sm font-semibold">
              {user?.name?.charAt(0) || "U"}
            </AvatarFallback>
          </Avatar>
          <div className="text-right">
            <div className="text-sm font-semibold text-foreground">
              ${portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
            <div className="text-xs text-muted-foreground">{t("portfolio")}</div>
          </div>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </Button>

        {/* Dropdown Menu */}
        {isOpen && (
          <Card className="absolute right-0 top-full mt-2 w-80 bg-popover border-border shadow-soft-xl z-50">
            <CardContent className="p-0">
              {/* Balance Section */}
              <div className="p-4 bg-muted/30 border-b border-border">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="text-lg font-bold text-foreground mb-2">
                      ${portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                    <div className="relative">
                      <select
                        value={selectedAccount}
                        onChange={(e) => handleAccountChange(e.target.value)}
                        className="text-sm text-white bg-black border border-gray-600 rounded px-2 py-1 cursor-pointer hover:bg-gray-900 transition-colors focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500 min-w-[140px]"
                      >
                        {accounts.map((account) => (
                          <option key={account.key} value={account.key} className="bg-black text-white">
                            {account.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-3 border-border text-muted-foreground hover:bg-accent shadow-soft"
                    onClick={handleRefreshBalance}
                    disabled={isRefreshing}
                  >
                    <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>

              {/* Menu Items */}
              <div className="p-2">
                <Button
                  variant="ghost"
                  className="w-full justify-start text-foreground hover:bg-accent mb-1"
                  onClick={() => handleMenuAction("profile")}
                >
                  <User className="h-4 w-4 mr-3" />
                  Perfil
                </Button>

                <div className="relative">
                  <Button
                    variant="ghost"
                    className={`w-full justify-start text-foreground hover:bg-accent mb-1 ${showLanguages ? "bg-accent" : ""}`}
                    onClick={() => handleMenuAction("language")}
                  >
                    <Globe className="h-4 w-4 mr-3" />
                    {t("idioma")}
                    <ChevronDown
                      className={`h-4 w-4 ml-auto transition-transform ${showLanguages ? "rotate-180" : ""}`}
                    />
                  </Button>

                  {/* Language Submenu */}
                  {showLanguages && (
                    <div className="ml-6 mb-2 space-y-1">
                      {languages.map((lang) => (
                        <Button
                          key={lang.key}
                          variant="ghost"
                          className="w-full justify-start text-sm text-muted-foreground hover:bg-accent py-1 h-auto"
                          onClick={() => handleLanguageChange(lang.key)}
                        >
                          <div className="flex items-center justify-between w-full">
                            <span>{lang.label}</span>
                            {language === lang.key && <Check className="h-3 w-3 text-primary" />}
                          </div>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>

                <Button
                  variant="ghost"
                  className="w-full justify-start text-foreground hover:bg-accent mb-3"
                  onClick={() => handleMenuAction("support")}
                >
                  <HelpCircle className="h-4 w-4 mr-3" />
                  {t("suporte")}
                </Button>

                <div className="border-t border-border pt-2">
                  <Button
                    variant="ghost"
                    className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => handleMenuAction("logout")}
                  >
                    <LogOut className="h-4 w-4 mr-3" />
                    {t("logout")}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Profile Modal */}
      <ProfileModal isOpen={showProfileModal} onClose={() => setShowProfileModal(false)} />
    </>
  )
}
