"use client"

import type React from "react"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import LeverageModal from "./leverage-modal"

interface TradingInterfaceProps {
  currentPrice: number
  balance: {
    usd: number
    btc: number
  }
  setBalance: React.Dispatch<
    React.SetStateAction<{
      usd: number
      btc: number
    }>
  >
  setTrades: React.Dispatch<React.SetStateAction<any[]>>
}

export default function TradingInterface({ currentPrice, balance, setBalance, setTrades }: TradingInterfaceProps) {
  const [orderType, setOrderType] = useState("limit")
  const [direction, setDirection] = useState<"buy" | "sell">("buy")
  const [limitPrice, setLimitPrice] = useState("")
  const [size, setSize] = useState("")
  const [sizeType, setSizeType] = useState<"USDT" | "BTC">("USDT")
  const [limitOnly, setLimitOnly] = useState(false)
  const [marginType, setMarginType] = useState<"cross" | "isolated">("cross")
  const [leverage, setLeverage] = useState(10)
  const [showLeverageModal, setShowLeverageModal] = useState(false)

  const needsPriceField = ["limit", "stop_loss", "take_profit"].includes(orderType)

  const handleTrade = () => {
    const sizeValue = Number.parseFloat(size)
    if (isNaN(sizeValue) || sizeValue <= 0) return

    let amount: number
    let cost: number

    if (sizeType === "USDT") {
      // Size em USDT
      cost = sizeValue
      amount = cost / currentPrice
    } else {
      // Size em BTC
      amount = sizeValue
      cost = amount * currentPrice
    }

    if (direction === "buy") {
      if (cost > balance.usd) return

      setBalance((prev) => ({
        usd: prev.usd - cost,
        btc: prev.btc + amount,
      }))

      setTrades((prev) => [
        ...prev,
        {
          id: Date.now(),
          type: "buy",
          orderType,
          amount,
          price: needsPriceField ? Number.parseFloat(limitPrice) || currentPrice : currentPrice,
          total: cost,
          time: new Date().toISOString(),
          limitOnly,
          marginType,
          leverage,
        },
      ])
    } else {
      if (amount > balance.btc) return

      const value = amount * currentPrice

      setBalance((prev) => ({
        usd: prev.usd + value,
        btc: prev.btc - amount,
      }))

      setTrades((prev) => [
        ...prev,
        {
          id: Date.now(),
          type: "sell",
          orderType,
          amount,
          price: needsPriceField ? Number.parseFloat(limitPrice) || currentPrice : currentPrice,
          total: value,
          time: new Date().toISOString(),
          limitOnly,
          marginType,
          leverage,
        },
      ])
    }

    setSize("")
    setLimitPrice("")
  }

  const getOrderTypeLabel = (type: string) => {
    switch (type) {
      case "limit":
        return "Limite"
      case "market":
        return "Mercado"
      case "market_maker":
        return "Market Maker"
      case "stop_loss":
        return "Stop Loss Market"
      case "take_profit":
        return "Take Profit Market"
      default:
        return type
    }
  }

  const calculateTotal = () => {
    const sizeValue = Number.parseFloat(size) || 0
    const price = needsPriceField ? Number.parseFloat(limitPrice) || currentPrice : currentPrice

    if (sizeType === "USDT") {
      return sizeValue
    } else {
      return sizeValue * price
    }
  }

  const calculateAmount = () => {
    const sizeValue = Number.parseFloat(size) || 0
    const price = needsPriceField ? Number.parseFloat(limitPrice) || currentPrice : currentPrice

    if (sizeType === "USDT") {
      return sizeValue / price
    } else {
      return sizeValue
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Manual Trading</CardTitle>
          <CardDescription>Execute trades with different order types</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Margin Type and Leverage */}
            <div className="grid grid-cols-2 gap-3">
              {/* Margin Type */}
              <div className="space-y-2">
                <Label className="text-sm">Tipo de Margem</Label>
                <Tabs value={marginType} onValueChange={(value) => setMarginType(value as "cross" | "isolated")}>
                  <TabsList className="grid w-full grid-cols-2 h-8">
                    <TabsTrigger value="cross" className="text-xs">
                      Cruzada
                    </TabsTrigger>
                    <TabsTrigger value="isolated" className="text-xs">
                      Isolada
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {/* Leverage */}
              <div className="space-y-2">
                <Label className="text-sm">Alavancagem</Label>
                <Button
                  variant="outline"
                  onClick={() => setShowLeverageModal(true)}
                  className="w-full h-8 justify-between text-sm border-gray-600 hover:bg-gray-700"
                >
                  <span>{leverage}x</span>
                  <span className="text-gray-400">⚙️</span>
                </Button>
              </div>
            </div>

            {/* Order Type Selection */}
            <div className="space-y-2">
              <Label>Order Type</Label>
              <Select value={orderType} onValueChange={setOrderType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select order type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="market">Mercado</SelectItem>
                  <SelectItem value="limit">Limite</SelectItem>
                  <SelectItem value="market_maker">Market Maker</SelectItem>
                  <SelectItem value="stop_loss">Stop Loss Market</SelectItem>
                  <SelectItem value="take_profit">Take Profit Market</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Direction Selection */}
            <div className="space-y-2">
              <Label>Direction</Label>
              <Tabs value={direction} onValueChange={(value) => setDirection(value as "buy" | "sell")}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="buy">Buy</TabsTrigger>
                  <TabsTrigger value="sell">Sell</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Limit Price Field (conditional) */}
            {needsPriceField && (
              <div className="space-y-2">
                <Label htmlFor="limit-price">
                  {orderType === "limit"
                    ? "Limit Price"
                    : orderType === "stop_loss"
                      ? "Stop Price"
                      : "Take Profit Price"}
                </Label>
                <Input
                  id="limit-price"
                  type="number"
                  placeholder={`Enter ${orderType} price`}
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  className="focus:ring-orange-500 focus:border-orange-500"
                />
              </div>
            )}

            {/* Size Field with Currency Selector */}
            <div className="space-y-2">
              <Label htmlFor="size">Size</Label>
              <div className="relative">
                <Input
                  id="size"
                  type="number"
                  placeholder="Enter size"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  className="pr-20 focus:ring-orange-500 focus:border-orange-500"
                />
                <div className="absolute right-2 top-1/2 transform -translate-y-1/2">
                  <Select value={sizeType} onValueChange={(value) => setSizeType(value as "USDT" | "BTC")}>
                    <SelectTrigger className="w-20 h-8 border-0 bg-transparent text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USDT">USDT</SelectItem>
                      <SelectItem value="BTC">BTC</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Reduce Only Checkbox */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="reduce-only"
                checked={limitOnly}
                onCheckedChange={(checked) => setLimitOnly(checked as boolean)}
              />
              <Label htmlFor="reduce-only" className="text-sm">
                Reduce only
              </Label>
            </div>

            {/* Order Summary */}
            <div className="space-y-2 p-3 bg-gray-800 rounded-lg">
              <div className="text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-400">Order Type:</span>
                  <span className="text-white">{getOrderTypeLabel(orderType)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Margin:</span>
                  <span className="text-white">{marginType === "cross" ? "Cruzada" : "Isolada"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Leverage:</span>
                  <span className="text-white">{leverage}x</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Price:</span>
                  <span className="text-white">
                    ${needsPriceField ? limitPrice || currentPrice.toLocaleString() : currentPrice.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Amount:</span>
                  <span className="text-white">{calculateAmount().toFixed(8)} BTC</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Total:</span>
                  <span className="text-white">${calculateTotal().toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Available:</span>
                  <span className="text-white">
                    {direction === "buy"
                      ? `$${balance.usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                      : `${balance.btc.toFixed(8)} BTC`}
                  </span>
                </div>
              </div>
            </div>

            {/* Execute Button */}
            <Button
              className={`w-full ${
                direction === "buy" ? "bg-orange-500 hover:bg-orange-600" : "bg-gray-600 hover:bg-gray-700"
              } text-white`}
              onClick={handleTrade}
              disabled={
                !size ||
                Number.parseFloat(size) <= 0 ||
                (needsPriceField && (!limitPrice || Number.parseFloat(limitPrice) <= 0)) ||
                (direction === "buy" && calculateTotal() > balance.usd) ||
                (direction === "sell" && calculateAmount() > balance.btc)
              }
            >
              {direction === "buy" ? "Buy" : "Sell"} BTC
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Leverage Modal */}
      <LeverageModal
        isOpen={showLeverageModal}
        onClose={() => setShowLeverageModal(false)}
        currentLeverage={leverage}
        onLeverageChange={setLeverage}
      />
    </>
  )
}
