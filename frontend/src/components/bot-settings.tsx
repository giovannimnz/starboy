"use client"

import type React from "react"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface BotSettingsProps {
  isRunning: boolean
  setIsRunning: React.Dispatch<React.SetStateAction<boolean>>
}

export default function BotSettings({ isRunning, setIsRunning }: BotSettingsProps) {
  const [strategy, setStrategy] = useState("simple")
  const [maxRisk, setMaxRisk] = useState("2")
  const [maxPositions, setMaxPositions] = useState("3")

  const handleToggleBot = () => {
    setIsRunning((prev) => !prev)
  }

  const getStrategyLabel = (strategyValue: string) => {
    switch (strategyValue) {
      case "simple":
        return "Simple Momentum"
      case "macd":
        return "MACD Crossover"
      case "rsi":
        return "RSI Oversold/Overbought"
      default:
        return strategyValue
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Bot Configuration</CardTitle>
          <CardDescription>Configure your trading bot parameters</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="strategy">Trading Strategy</Label>
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger id="strategy">
                <SelectValue placeholder="Select strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">Simple Momentum</SelectItem>
                <SelectItem value="macd">MACD Crossover</SelectItem>
                <SelectItem value="rsi">RSI Oversold/Overbought</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-risk">Max Risk (%)</Label>
            <Input
              id="max-risk"
              type="number"
              min="1"
              max="10"
              step="0.1"
              placeholder="Enter risk percentage (1-10%)"
              value={maxRisk}
              onChange={(e) => setMaxRisk(e.target.value)}
              className="focus:ring-orange-500 focus:border-orange-500"
            />
            <p className="text-xs text-gray-400">Recommended: 1-5% for conservative, 5-10% for aggressive trading</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-positions">Max Simultaneous Positions</Label>
            <Select value={maxPositions} onValueChange={setMaxPositions}>
              <SelectTrigger id="max-positions">
                <SelectValue placeholder="Select max positions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 Position</SelectItem>
                <SelectItem value="2">2 Positions</SelectItem>
                <SelectItem value="3">3 Positions</SelectItem>
                <SelectItem value="4">4 Positions</SelectItem>
                <SelectItem value="5">5 Positions</SelectItem>
                <SelectItem value="6">6 Positions</SelectItem>
                <SelectItem value="7">7 Positions</SelectItem>
                <SelectItem value="8">8 Positions</SelectItem>
                <SelectItem value="9">9 Positions</SelectItem>
                <SelectItem value="10">10 Positions</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-400">Maximum number of open positions at the same time</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button className="w-full bg-orange-500 hover:bg-orange-600" onClick={handleToggleBot}>
            {isRunning ? "Stop Bot" : "Start Bot"}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bot Status</CardTitle>
          <CardDescription>Current configuration and performance</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="bot-status">Bot Status</Label>
            <div className="flex items-center space-x-2">
              <Switch id="bot-status" checked={isRunning} onCheckedChange={handleToggleBot} />
              <span>{isRunning ? "Running" : "Stopped"}</span>
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-gray-700">
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">Strategy:</span>
                <span className="font-medium text-white">{getStrategyLabel(strategy)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">Max Risk:</span>
                <span className="font-medium text-white">{maxRisk}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">Max Positions:</span>
                <span className="font-medium text-white">{maxPositions}</span>
              </div>
            </div>
          </div>

          <div className="space-y-2 pt-4 border-t border-gray-700">
            <div className="text-sm text-gray-400 mb-2">Performance Metrics</div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-xs text-gray-500">Active Positions:</span>
                <span className="text-xs text-white">0/{maxPositions}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-gray-500">Total Trades:</span>
                <span className="text-xs text-white">0</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-gray-500">Win Rate:</span>
                <span className="text-xs text-white">0%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-gray-500">P&L:</span>
                <span className="text-xs text-white">$0.00</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
