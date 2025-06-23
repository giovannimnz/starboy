"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Search } from "lucide-react"

interface TradingViewChartProps {
  selectedAccount: string
}

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

export default function TradingViewChart({ selectedAccount }: TradingViewChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT.P")
  const [searchTerm, setSearchTerm] = useState("")
  const [isSelectOpen, setIsSelectOpen] = useState(false)

  // Get available pairs for selected account
  const getAvailablePairs = () => {
    const accountKey = selectedAccount as keyof typeof tradingPairs
    return tradingPairs[accountKey] || tradingPairs["binance.futures"]
  }

  // Filter pairs based on search term
  const filteredPairs = getAvailablePairs().filter(
    (pair) =>
      pair.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (pair.displaySymbol || pair.symbol).toLowerCase().includes(searchTerm.toLowerCase()),
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

    const selectedPair = getAvailablePairs().find((pair) => pair.symbol === selectedSymbol) || getAvailablePairs()[0]
    const tradingViewSymbol = getTradingViewSymbol(selectedPair)

    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tradingViewSymbol,
      interval: "15",
      timezone: "America/Sao_Paulo",
      theme: "dark",
      style: "1",
      locale: "pt_BR",
      toolbar_bg: "#1a1a1a",
      enable_publishing: false,
      backgroundColor: "#1a1a1a",
      gridColor: "#333333",
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      container_id: "tradingview_chart",
      studies: ["Volume@tv-basicstudies"],
      overrides: {
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
  }, [selectedSymbol, selectedAccount])

  // Update selected symbol when account changes
  useEffect(() => {
    const availablePairs = getAvailablePairs()
    if (availablePairs.length > 0) {
      setSelectedSymbol(availablePairs[0].symbol)
    }
  }, [selectedAccount])

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

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-white">Gráfico de Preços</CardTitle>
          <div className="relative w-64">
            <Select open={isSelectOpen} onOpenChange={setIsSelectOpen}>
              <SelectTrigger
                className="bg-gray-800 border-gray-600 text-white focus:border-orange-500"
                onClick={() => setIsSelectOpen(!isSelectOpen)}
              >
                <SelectValue placeholder="Selecione o par">
                  <span className="truncate">{getCurrentPairDisplay()}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-600 max-h-80">
                <div className="p-2 border-b border-gray-600">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder="Pesquisar par..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-8 bg-gray-700 border-gray-600 text-white focus:border-orange-500"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {filteredPairs.length === 0 ? (
                    <div className="p-3 text-gray-400 text-center">Nenhum par encontrado</div>
                  ) : (
                    filteredPairs.map((pair) => (
                      <SelectItem
                        key={pair.symbol}
                        value={pair.symbol}
                        className="text-white hover:bg-gray-700 focus:bg-gray-700 cursor-pointer"
                        onClick={() => handleSymbolSelect(pair.symbol)}
                      >
                        <div className="flex flex-col">
                          <span className="font-medium">{pair.displaySymbol || pair.symbol.replace(".P", "")}</span>
                          <span className="text-xs text-gray-400">{pair.name}</span>
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
          <div id="tradingview_chart" ref={chartContainerRef} className="h-full w-full bg-gray-900 rounded-b-lg" />
        </div>
      </CardContent>
    </Card>
  )
}
