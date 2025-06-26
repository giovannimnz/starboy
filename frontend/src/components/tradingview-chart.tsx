"use client"

import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api" // certifique-se de importar sua api
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Search, Clock, TrendingUp, TrendingDown } from "lucide-react"
import { useTheme } from "next-themes"

interface TradingViewChartProps {
  selectedAccount: string
  selectedAccountId: number | null // Passe o ID da conta selecionada!
}

interface Signal {
  id: number
  type: "buy" | "sell"
  pair: string
  price: number
  confidence: number
  time: string
  status: "active" | "completed" | "expired"
}

// Mock data for recent signals
const mockSignals: Signal[] = [
  {
    id: 1,
    type: "buy",
    pair: "BTC/USDT",
    price: 29876.54,
    confidence: 85,
    time: "14:32",
    status: "active",
  },
  {
    id: 2,
    type: "sell",
    pair: "ETH/USDT",
    price: 1842.33,
    confidence: 78,
    time: "14:15",
    status: "completed",
  },
  {
    id: 3,
    type: "buy",
    pair: "ADA/USDT",
    price: 0.3456,
    confidence: 92,
    time: "13:58",
    status: "active",
  },
  {
    id: 4,
    type: "sell",
    pair: "SOL/USDT",
    price: 24.87,
    confidence: 71,
    time: "13:42",
    status: "expired",
  },
  {
    id: 5,
    type: "buy",
    pair: "DOT/USDT",
    price: 5.234,
    confidence: 88,
    time: "13:28",
    status: "completed",
  },
]

// Mock trading pairs data
const tradingPairs = {
  "binance.spot": [
    { symbol: "BTCUSDT", name: "Bitcoin", exchange: "BINANCE" },
    { symbol: "ETHUSDT", name: "Ethereum", exchange: "BINANCE" },
    { symbol: "ADAUSDT", name: "Cardano", exchange: "BINANCE" },
    { symbol: "SOLUSDT", name: "Solana", exchange: "BINANCE" },
    { symbol: "DOTUSDT", name: "Polkadot", exchange: "BINANCE" },
    { symbol: "LINKUSDT", name: "Chainlink", exchange: "BINANCE" },
    { symbol: "MATICUSDT", name: "Polygon", exchange: "BINANCE" },
    { symbol: "AVAXUSDT", name: "Avalanche", exchange: "BINANCE" },
    { symbol: "UNIUSDT", name: "Uniswap", exchange: "BINANCE" },
    { symbol: "LTCUSDT", name: "Litecoin", exchange: "BINANCE" },
  ],
  "binance.futures": [
    { symbol: "BTCUSDT.P", name: "Bitcoin", exchange: "BINANCE", displaySymbol: "BTCUSDT" },
    { symbol: "ETHUSDT.P", name: "Ethereum", exchange: "BINANCE", displaySymbol: "ETHUSDT" },
    { symbol: "ADAUSDT.P", name: "Cardano", exchange: "BINANCE", displaySymbol: "ADAUSDT" },
    { symbol: "SOLUSDT.P", name: "Solana", exchange: "BINANCE", displaySymbol: "SOLUSDT" },
    { symbol: "DOTUSDT.P", name: "Polkadot", exchange: "BINANCE", displaySymbol: "DOTUSDT" },
    { symbol: "LINKUSDT.P", name: "Chainlink", exchange: "BINANCE", displaySymbol: "LINKUSDT" },
    { symbol: "MATICUSDT.P", name: "Polygon", exchange: "BINANCE", displaySymbol: "MATICUSDT" },
    { symbol: "AVAXUSDT.P", name: "Avalanche", exchange: "BINANCE", displaySymbol: "AVAXUSDT" },
    { symbol: "UNIUSDT.P", name: "Uniswap", exchange: "BINANCE", displaySymbol: "UNIUSDT" },
    { symbol: "LTCUSDT.P", name: "Litecoin", exchange: "BINANCE", displaySymbol: "LTCUSDT" },
  ],
  "mexc.spot": [
    { symbol: "BTCUSDT", name: "Bitcoin", exchange: "MEXC" },
    { symbol: "ETHUSDT", name: "Ethereum", exchange: "MEXC" },
    { symbol: "ADAUSDT", name: "Cardano", exchange: "MEXC" },
    { symbol: "SOLUSDT", name: "Solana", exchange: "MEXC" },
    { symbol: "DOTUSDT", name: "Polkadot", exchange: "MEXC" },
  ],
  "mexc.futures": [
    { symbol: "BTC_USDT", name: "Bitcoin", exchange: "MEXC", displaySymbol: "BTCUSDT" },
    { symbol: "ETH_USDT", name: "Ethereum", exchange: "MEXC", displaySymbol: "ETHUSDT" },
    { symbol: "ADA_USDT", name: "Cardano", exchange: "MEXC", displaySymbol: "ADAUSDT" },
    { symbol: "SOL_USDT", name: "Solana", exchange: "MEXC", displaySymbol: "SOLUSDT" },
    { symbol: "DOT_USDT", name: "Polkadot", exchange: "MEXC", displaySymbol: "DOTUSDT" },
  ],
}

export default function TradingViewChart({ selectedAccount, selectedAccountId }: TradingViewChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT.P")
  const [searchTerm, setSearchTerm] = useState("")
  const [isSelectOpen, setIsSelectOpen] = useState(false)
  const [symbols, setSymbols] = useState<any[]>([])
  const [loadingSymbols, setLoadingSymbols] = useState(false)
  const { theme } = useTheme()

  // Get available pairs for selected account
  const getAvailablePairs = () => {
    const accountKey = selectedAccount as keyof typeof tradingPairs
    return tradingPairs[accountKey] || tradingPairs["binance.futures"]
  }

  // Filter pairs based on search term
  const filteredPairs = symbols.filter(
    (pair) =>
      pair.base_asset.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pair.symbol.toLowerCase().includes(searchTerm.toLowerCase()),
  )

  // Get TradingView symbol format
  const getTradingViewSymbol = (pair: any) => {
    if (selectedAccount.includes("binance")) {
      return `BINANCE:${pair.symbol}`
    } else if (selectedAccount.includes("mexc")) {
      return `MEXC:${pair.symbol}`
    }
    return `BINANCE:${pair.symbol}`
  }

  // Initialize TradingView widget
  useEffect(() => {
    if (!chartContainerRef.current) return

    // Clear previous widget
    chartContainerRef.current.innerHTML = ""

    const script = document.createElement("script")
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"
    script.type = "text/javascript"
    script.async = true

    const selectedPair = symbols.find((pair) => pair.symbol === selectedSymbol) || symbols[0]
    const tradingViewSymbol = selectedPair ? `BINANCE:${selectedPair.symbol}` : "BINANCE:BTCUSDT"

    const isLightTheme = theme === "light"

    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tradingViewSymbol,
      interval: "15",
      timezone: "America/Sao_Paulo",
      theme: isLightTheme ? "light" : "dark",
      style: "1",
      locale: "pt_BR",
      toolbar_bg: isLightTheme ? "#ffffff" : "#1a1a1a",
      enable_publishing: false,
      backgroundColor: isLightTheme ? "#ffffff" : "#1a1a1a",
      gridColor: isLightTheme ? "#e5e7eb" : "#333333",
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      container_id: "tradingview_chart",
      studies: ["Volume@tv-basicstudies"],
      overrides: isLightTheme
        ? {
            "paneProperties.background": "#ffffff",
            "paneProperties.backgroundType": "solid",
            "paneProperties.gridProperties.color": "#e5e7eb",
            "scalesProperties.textColor": "#374151",
            "scalesProperties.backgroundColor": "#ffffff",
            "mainSeriesProperties.candleStyle.upColor": "#10b981",
            "mainSeriesProperties.candleStyle.downColor": "#ef4444",
            "mainSeriesProperties.candleStyle.borderUpColor": "#10b981",
            "mainSeriesProperties.candleStyle.borderDownColor": "#ef4444",
            "mainSeriesProperties.candleStyle.wickUpColor": "#10b981",
            "mainSeriesProperties.candleStyle.wickDownColor": "#ef4444",
            volumePaneSize: "medium",
          }
        : {
            "paneProperties.background": "#1a1a1a",
            "paneProperties.backgroundType": "solid",
            "paneProperties.gridProperties.color": "#333333",
            "scalesProperties.textColor": "#ffffff",
            "scalesProperties.backgroundColor": "#1a1a1a",
            "mainSeriesProperties.candleStyle.upColor": "#00ff88",
            "mainSeriesProperties.candleStyle.downColor": "#ff4444",
            "mainSeriesProperties.candleStyle.borderUpColor": "#00ff88",
            "mainSeriesProperties.candleStyle.borderDownColor": "#ff4444",
            "mainSeriesProperties.candleStyle.wickUpColor": "#00ff88",
            "mainSeriesProperties.candleStyle.wickDownColor": "#ff4444",
            volumePaneSize: "medium",
          },
    })

    chartContainerRef.current.appendChild(script)

    return () => {
      if (chartContainerRef.current) {
        chartContainerRef.current.innerHTML = ""
      }
    }
  }, [selectedSymbol, selectedAccount, theme])

  // Update selected symbol when account changes
  useEffect(() => {
    const availablePairs = getAvailablePairs()
    if (availablePairs.length > 0) {
      setSelectedSymbol(availablePairs[0].symbol)
    }
  }, [selectedAccount])

  // Fetch symbols for the selected account
  useEffect(() => {
    if (!selectedAccountId) return
    setLoadingSymbols(true)
    api.getAccountSymbols(selectedAccountId)
      .then(res => {
        if (res.success) setSymbols(res.data)
      })
      .finally(() => setLoadingSymbols(false))
  }, [selectedAccountId])

  const handleSymbolSelect = (symbol: string) => {
    setSelectedSymbol(symbol)
    setIsSelectOpen(false)
    setSearchTerm("")
  }

  const getDisplayName = (pair: any) => {
    const displaySymbol = pair.displaySymbol || pair.symbol.replace(".P", "")
    return `${displaySymbol} - ${pair.name}`
  }

  const getCurrentPairDisplay = () => {
    const currentPair = getAvailablePairs().find((pair) => pair.symbol === selectedSymbol)
    if (!currentPair) return "BTCUSDT - Bitcoin"
    return getDisplayName(currentPair)
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-500/20 text-green-400 border-green-500/30"
      case "completed":
        return "bg-blue-500/20 text-blue-400 border-blue-500/30"
      case "expired":
        return "bg-gray-500/20 text-gray-400 border-gray-500/30"
      default:
        return "bg-gray-500/20 text-gray-400 border-gray-500/30"
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case "active":
        return "Ativo"
      case "completed":
        return "OK"
      case "expired":
        return "Exp"
      default:
        return status
    }
  }

  return (
    <Card className="h-full shadow-soft-md border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-foreground font-semibold">Gráfico de Preços</CardTitle>
          <div className="relative w-64">
            <Select open={isSelectOpen} onOpenChange={setIsSelectOpen}>
              <SelectTrigger
                className="bg-background border-border text-foreground focus:border-primary focus:ring-1 focus:ring-primary/20 shadow-soft"
                onClick={() => setIsSelectOpen(!isSelectOpen)}
              >
                <SelectValue placeholder="Selecione o par">
                  <span className="truncate">{getCurrentPairDisplay()}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="bg-popover border-border max-h-80 shadow-soft-lg">
                <div className="p-2 border-b border-border">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Pesquisar par..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-8 bg-background border-border text-foreground focus:border-primary focus:ring-1 focus:ring-primary/20"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {loadingSymbols ? (
                    <div className="p-3 text-muted-foreground text-center">Carregando...</div>
                  ) : filteredPairs.length === 0 ? (
                    <div className="p-3 text-muted-foreground text-center">Nenhum par encontrado</div>
                  ) : (
                    filteredPairs.map((pair) => (
                      <SelectItem
                        key={pair.symbol}
                        value={pair.symbol}
                        className="text-foreground hover:bg-accent focus:bg-accent cursor-pointer"
                        onClick={() => handleSymbolSelect(pair.symbol)}
                      >
                        <div className="flex flex-col">
                          <span className="font-medium">{pair.symbol}</span>
                          <span className="text-xs text-muted-foreground">{pair.base_asset} / {pair.quote_asset}</span>
                        </div>
                      </SelectItem>
                    ))
                  )}
                </div>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="h-[400px] w-full">
          <div id="tradingview_chart" ref={chartContainerRef} className="h-full w-full bg-background rounded-b-lg" />
        </div>

        {/* Recent Signals Section */}
        <div className="p-4 border-t border-border bg-card/50">
          <div className="flex items-center mb-3">
            <Clock className="h-4 w-4 mr-2 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Últimos 5 Sinais</h3>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {mockSignals.map((signal) => (
              <div
                key={signal.id}
                className="bg-gray-800/50 border border-gray-700 rounded-lg p-2 hover:bg-gray-800/70 transition-colors"
              >
                <div className="flex flex-col items-center space-y-1">
                  {/* Icon and Type */}
                  <div className={`p-1.5 rounded-full ${signal.type === "buy" ? "bg-green-500/20" : "bg-red-500/20"}`}>
                    {signal.type === "buy" ? (
                      <TrendingUp className="h-3 w-3 text-green-400" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-red-400" />
                    )}
                  </div>

                  {/* Pair */}
                  <div className="text-xs font-semibold text-foreground text-center">
                    {signal.pair.replace("/USDT", "")}
                  </div>

                  {/* Price */}
                  <div className="text-xs text-muted-foreground text-center">
                    $
                    {signal.price < 1
                      ? signal.price.toFixed(4)
                      : signal.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </div>

                  {/* Time and Status */}
                  <div className="flex flex-col items-center space-y-1">
                    <div className="text-xs text-muted-foreground">{signal.time}</div>
                    <Badge variant="outline" className={`text-xs px-1 py-0 h-4 ${getStatusColor(signal.status)}`}>
                      {getStatusText(signal.status)}
                    </Badge>
                  </div>

                  {/* Confidence */}
                  <div className="text-xs text-primary font-medium">{signal.confidence}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
