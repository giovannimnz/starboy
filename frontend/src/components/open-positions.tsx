"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown } from "lucide-react"

interface Position {
  id: number
  symbol: string
  type: "long" | "short"
  amount: number
  entryPrice: number
  currentPrice: number
  pnl: number
  pnlPercentage: number
}

interface OpenPositionsProps {
  currentPrice: number
  balance: {
    usd: number
    btc: number
  }
}

export default function OpenPositions({ currentPrice, balance }: OpenPositionsProps) {
  // Mock positions based on current balance
  const positions: Position[] =
    balance.btc > 0
      ? [
          {
            id: 1,
            symbol: "BTC/USD",
            type: "long",
            amount: balance.btc,
            entryPrice: 30000, // Mock entry price
            currentPrice: currentPrice,
            pnl: (currentPrice - 30000) * balance.btc,
            pnlPercentage: ((currentPrice - 30000) / 30000) * 100,
          },
        ]
      : []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Open Positions</CardTitle>
        <CardDescription>Your current trading positions</CardDescription>
      </CardHeader>
      <CardContent>
        {positions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No open positions. Start trading to see your positions here.
          </div>
        ) : (
          <div className="space-y-4">
            {positions.map((position) => (
              <div key={position.id} className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="font-semibold">{position.symbol}</span>
                    <Badge variant={position.type === "long" ? "default" : "secondary"}>
                      {position.type.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="flex items-center space-x-1">
                    {position.pnl >= 0 ? (
                      <TrendingUp className="h-4 w-4 text-green-500" />
                    ) : (
                      <TrendingDown className="h-4 w-4 text-red-500" />
                    )}
                    <span className={position.pnl >= 0 ? "text-green-500" : "text-red-500"}>
                      {position.pnlPercentage >= 0 ? "+" : ""}
                      {position.pnlPercentage.toFixed(2)}%
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Amount:</span>
                    <div className="font-medium">{position.amount.toFixed(8)} BTC</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Entry Price:</span>
                    <div className="font-medium">${position.entryPrice.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Current Price:</span>
                    <div className="font-medium">${position.currentPrice.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">P&L:</span>
                    <div className={`font-medium ${position.pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                      {position.pnl >= 0 ? "+" : ""}${position.pnl.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
