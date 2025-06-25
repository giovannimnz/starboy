"use client"

import type React from "react"

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"

interface LeverageModalProps {
  isOpen: boolean
  onClose: () => void
  currentLeverage: number
  onLeverageChange: (leverage: number) => void
}

export default function LeverageModal({ isOpen, onClose, currentLeverage, onLeverageChange }: LeverageModalProps) {
  const [leverage, setLeverage] = useState(currentLeverage)

  const handleSave = () => {
    onLeverageChange(leverage)
    onClose()
  }

  const handleSliderChange = (value: number[]) => {
    setLeverage(value[0])
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value)
    if (value >= 1 && value <= 125) {
      setLeverage(value)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md bg-gray-900 border-gray-700">
        <DialogHeader>
          <DialogTitle className="text-white">Ajustar Alavancagem</DialogTitle>
          <DialogDescription className="text-gray-400">
            Selecione a alavancagem desejada para suas operações
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Input de Alavancagem */}
          <div className="space-y-2">
            <Label htmlFor="leverage-input" className="text-white">
              Alavancagem
            </Label>
            <div className="relative">
              <Input
                id="leverage-input"
                type="number"
                min="1"
                max="125"
                value={leverage}
                onChange={handleInputChange}
                className="bg-gray-700 border-gray-600 text-white focus:border-orange-500 pr-8"
              />
              <span className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 text-sm">x</span>
            </div>
          </div>

          {/* Slider de Alavancagem */}
          <div className="space-y-3">
            <Label className="text-white">Ajuste rápido</Label>
            <div className="px-2">
              <Slider
                value={[leverage]}
                onValueChange={handleSliderChange}
                max={125}
                min={1}
                step={1}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>1x</span>
                <span>25x</span>
                <span>50x</span>
                <span>75x</span>
                <span>100x</span>
                <span>125x</span>
              </div>
            </div>
          </div>

          {/* Valores Comuns */}
          <div className="space-y-2">
            <Label className="text-white">Valores comuns</Label>
            <div className="grid grid-cols-4 gap-2">
              {[1, 5, 10, 20, 50, 75, 100, 125].map((value) => (
                <Button
                  key={value}
                  variant={leverage === value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setLeverage(value)}
                  className={
                    leverage === value
                      ? "bg-orange-500 hover:bg-orange-600 text-white"
                      : "border-gray-600 text-gray-300 hover:bg-gray-700"
                  }
                >
                  {value}x
                </Button>
              ))}
            </div>
          </div>

          {/* Aviso de Risco */}
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <p className="text-yellow-400 text-xs">
              ⚠️ <strong>Aviso:</strong> Alavancagem alta aumenta tanto os lucros quanto as perdas potenciais. Use com
              cautela.
            </p>
          </div>
        </div>

        <div className="flex justify-end space-x-3 mt-6">
          <Button variant="outline" onClick={onClose} className="border-gray-600 text-gray-300 hover:bg-gray-700">
            Cancelar
          </Button>
          <Button onClick={handleSave} className="bg-orange-500 hover:bg-orange-600 text-white">
            Aplicar {leverage}x
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
