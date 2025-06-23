"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowUpRight, ArrowDownRight } from "lucide-react"

interface Trade {
  id: number
  type: "buy" | "sell"
  amount: number
  price: number
  total: number
  time: string
}

interface TradeHistoryProps {
  trades: Trade[]
}

export default function TradeHistory({ trades }: TradeHistoryProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trade History</CardTitle>
        <CardDescription>Your recent trading activity</CardDescription>
      </CardHeader>
      <CardContent>
        {trades.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No trades yet. Start trading to see your history.
          </div>
        ) : (
          <div className="space-y-4">
            {trades
              .slice()
              .reverse()
              .map((trade) => (
                <div key={trade.id} className="flex items-center justify-between border-b pb-3">
                  <div className="flex items-center space-x-3">
                    <div className={`p-2 rounded-full ${trade.type === "buy" ? "bg-green-100" : "bg-red-100"}`}>
                      {trade.type === "buy" ? (
                        <ArrowUpRight className="h-5 w-5 text-green-600" />
                      ) : (
                        <ArrowDownRight className="h-5 w-5 text-red-600" />
                      )}
                    </div>
                    <div>
                      <div className="font-medium">{trade.type === "buy" ? "Buy" : "Sell"} BTC</div>
                      <div className="text-sm text-muted-foreground">{new Date(trade.time).toLocaleString()}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">{trade.amount.toFixed(8)} BTC</div>
                    <div className="text-sm text-muted-foreground">
                      ${trade.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
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
