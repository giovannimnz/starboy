"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import TradingInterface from "@/components/trading-interface"
import BotSettings from "@/components/bot-settings"
import TradeHistory from "@/components/trade-history"
import OpenPositions from "@/components/open-positions"
import UserMenu from "@/components/user-menu"
import { BarChart3, Settings, History, TrendingUp } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { useLanguage } from "@/contexts/language-context"
import TradingViewChart from "@/components/tradingview-chart"

export default function Dashboard() {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState("dashboard")
  const [currentPrice, setCurrentPrice] = useState(29876.54)
  const [priceChange, setPriceChange] = useState(2.34)
  const [priceDirection, setPriceDirection] = useState<"up" | "down">("up")
  const [priceHistory, setPriceHistory] = useState([])
  const [isRunning, setIsRunning] = useState(false)
  const [trades, setTrades] = useState<any[]>([])
  const [selectedAccount, setSelectedAccount] = useState("binance.futures")

  // Balances separados para cada conta
  const [balances, setBalances] = useState({
    "binance.spot": {
      usd: 8500,
      btc: 0.3,
    },
    "binance.futures": {
      usd: 10000,
      btc: 0.5,
    },
  })

  // Função para obter o saldo da conta selecionada
  const getCurrentBalance = () => {
    return balances[selectedAccount as keyof typeof balances] || balances["binance.futures"]
  }

  // Função para atualizar o saldo da conta selecionada
  const setCurrentBalance = (newBalance: { usd: number; btc: number }) => {
    setBalances((prev) => ({
      ...prev,
      [selectedAccount]: newBalance,
    }))
  }

  // Função para lidar com mudança de conta
  const handleAccountChange = (account: string) => {
    setSelectedAccount(account)
  }

  const currentBalance = getCurrentBalance()
  const portfolioValue = currentBalance.usd + currentBalance.btc * currentPrice

  return (
    <div className="min-h-screen bg-dark-gradient">
      <div className="container mx-auto p-4">
        <div className="flex flex-col space-y-6">
          {/* Header */}
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-4xl font-bold text-gradient mb-2">{t("atius.capital")}</h1>
              <p className="text-muted-foreground font-medium">{t("professional.trading.platform")}</p>
            </div>
            <div className="flex items-center space-x-4">
              <ThemeToggle />
              <UserMenu balance={currentBalance} currentPrice={currentPrice} onAccountChange={handleAccountChange} />
            </div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="bg-card-dark shadow-soft-md border-border hover:shadow-soft-lg transition-shadow duration-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Saldo da conta
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-foreground">
                  ${portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {selectedAccount === "binance.spot" ? "Binance Spot" : "Binance Futures"}
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card-dark shadow-soft-md border-border hover:shadow-soft-lg transition-shadow duration-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Negociações em aberto
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-foreground">{currentBalance.btc > 0 ? 1 : 0}</div>
                      <div className="text-xs text-muted-foreground mt-1">Posições</div>
                    </div>
                  </div>
                  <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-foreground">0</div>
                      <div className="text-xs text-muted-foreground mt-1">Ordens</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card-dark shadow-soft-md border-border hover:shadow-soft-lg transition-shadow duration-200">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  {t("bot.status")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center">
                  <div
                    className={`h-3 w-3 rounded-full mr-3 ${
                      isRunning
                        ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]"
                        : "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                    }`}
                  ></div>
                  <span className="font-semibold text-foreground text-lg">
                    {isRunning ? t("running") : t("stopped")}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Main Content */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList className="grid grid-cols-4 w-full max-w-2xl bg-gray-800/50 p-1 shadow-soft border border-gray-700">
              <TabsTrigger
                value="dashboard"
                className="flex items-center data-[state=active]:bg-gray-700 data-[state=active]:shadow-soft data-[state=active]:text-primary"
              >
                <BarChart3 className="h-4 w-4 mr-2" />
                {t("dashboard")}
              </TabsTrigger>
              <TabsTrigger
                value="positions"
                className="flex items-center data-[state=active]:bg-gray-700 data-[state=active]:shadow-soft data-[state=active]:text-primary"
              >
                <TrendingUp className="h-4 w-4 mr-2" />
                {t("positions")}
              </TabsTrigger>
              <TabsTrigger
                value="history"
                className="flex items-center data-[state=active]:bg-gray-700 data-[state=active]:shadow-soft data-[state=active]:text-primary"
              >
                <History className="h-4 w-4 mr-2" />
                {t("history")}
              </TabsTrigger>
              <TabsTrigger
                value="settings"
                className="flex items-center data-[state=active]:bg-gray-700 data-[state=active]:shadow-soft data-[state=active]:text-primary"
              >
                <Settings className="h-4 w-4 mr-2" />
                {t("settings")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="dashboard" className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2">
                  <TradingViewChart selectedAccount={selectedAccount} />
                </div>
                <div>
                  <TradingInterface
                    currentPrice={currentPrice}
                    balance={currentBalance}
                    setBalance={setCurrentBalance}
                    setTrades={setTrades}
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="positions">
              <OpenPositions currentPrice={currentPrice} balance={currentBalance} />
            </TabsContent>

            <TabsContent value="history">
              <TradeHistory trades={trades} />
            </TabsContent>

            <TabsContent value="settings">
              <BotSettings isRunning={isRunning} setIsRunning={setIsRunning} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
