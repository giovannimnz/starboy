"use client"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"

interface PriceChartProps {
  data: Array<{
    time: string
    price: number
  }>
}

export default function PriceChart({ data }: PriceChartProps) {
  const formattedData = data.map((item) => ({
    time: new Date(item.time).toLocaleTimeString(),
    price: item.price,
  }))

  return (
    <div className="w-full h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={formattedData}
          margin={{
            top: 5,
            right: 30,
            left: 20,
            bottom: 5,
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 12, fill: "#fff" }}
            tickFormatter={(value) => {
              return value.split(":").slice(0, 2).join(":")
            }}
            axisLine={{ stroke: "#333" }}
            tickLine={{ stroke: "#333" }}
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 12, fill: "#fff" }}
            tickFormatter={(value) => `$${value.toLocaleString()}`}
            axisLine={{ stroke: "#333" }}
            tickLine={{ stroke: "#333" }}
          />
          <Tooltip
            formatter={(value: any) => [`$${Number(value).toLocaleString()}`, "Price"]}
            labelFormatter={(label) => `Time: ${label}`}
            contentStyle={{
              backgroundColor: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "8px",
              color: "#fff",
            }}
          />
          <Line
            type="monotone"
            dataKey="price"
            stroke="#ff6600"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6, fill: "#ff6600" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
