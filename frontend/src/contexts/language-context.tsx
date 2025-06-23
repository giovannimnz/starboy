"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"

type Language = "pt" | "en" | "es"

interface LanguageContextType {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string) => string
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (context === undefined) {
    throw new Error("useLanguage must be used within a LanguageProvider")
  }
  return context
}

const translations = {
  pt: {
    // Header
    "atius.capital": "Atius Capital",
    "professional.trading.platform": "Plataforma de Trading Profissional",

    // Dashboard
    "current.btc.price": "Preço Atual do BTC",
    "portfolio.value": "Valor do Portfólio",
    "bot.status": "Status do Bot",
    running: "Executando",
    stopped: "Parado",
    dashboard: "Dashboard",
    positions: "Posições",
    history: "Histórico",
    settings: "Configurações",

    // Trading Interface
    "manual.trading": "Trading Manual",
    "execute.trades": "Execute trades com diferentes tipos de ordem",
    "order.type": "Tipo de Ordem",
    market: "Mercado",
    limit: "Limite",
    "stop.loss.market": "Stop Loss Market",
    "take.profit.market": "Take Profit Market",
    direction: "Direção",
    buy: "Comprar",
    sell: "Vender",
    "limit.price": "Preço Limite",
    "stop.price": "Preço Stop",
    "take.profit.price": "Preço Take Profit",
    "enter.limit.price": "Digite o preço limite",
    "enter.stop.price": "Digite o preço stop",
    "enter.take.profit.price": "Digite o preço take profit",
    size: "Tamanho",
    "enter.size": "Digite o tamanho",
    "limit.only": "Apenas Limite",
    price: "Preço",
    amount: "Quantidade",
    total: "Total",
    available: "Disponível",
    "buy.btc": "Comprar BTC",
    "sell.btc": "Vender BTC",

    // Bot Settings
    "bot.configuration": "Configuração do Bot",
    "configure.bot.parameters": "Configure os parâmetros do seu bot de trading",
    "trading.strategy": "Estratégia de Trading",
    "select.strategy": "Selecione a estratégia",
    "simple.momentum": "Momentum Simples",
    "macd.crossover": "Cruzamento MACD",
    "rsi.oversold.overbought": "RSI Sobrevendido/Sobrecomprado",
    "max.risk": "Risco Máximo (%)",
    "enter.risk.percentage": "Digite a porcentagem de risco (1-10%)",
    "risk.recommendation": "Recomendado: 1-5% para conservador, 5-10% para agressivo",
    "max.simultaneous.positions": "Máximo de Posições Simultâneas",
    "select.max.positions": "Selecione o máximo de posições",
    position: "Posição",
    positions: "Posições",
    "maximum.positions.help": "Número máximo de posições abertas ao mesmo tempo",
    "start.bot": "Iniciar Bot",
    "stop.bot": "Parar Bot",
    "current.configuration": "Configuração atual e performance",
    strategy: "Estratégia",
    "max.positions": "Máx. Posições",
    "performance.metrics": "Métricas de Performance",
    "active.positions": "Posições Ativas",
    "total.trades": "Total de Trades",
    "win.rate": "Taxa de Vitória",

    // Open Positions
    "open.positions": "Posições Abertas",
    "current.trading.positions": "Suas posições de trading atuais",
    "no.open.positions": "Nenhuma posição aberta. Comece a negociar para ver suas posições aqui.",
    long: "COMPRA",
    short: "VENDA",
    "entry.price": "Preço de Entrada",
    "current.price": "Preço Atual",

    // Trade History
    "trade.history": "Histórico de Trades",
    "recent.trading.activity": "Sua atividade de trading recente",
    "no.trades.yet": "Nenhum trade ainda. Comece a negociar para ver seu histórico.",

    // User Menu
    portfolio: "Portfólio",
    "usd.balance": "Saldo USD",
    "btc.balance": "Saldo BTC",
    perfil: "Perfil",
    idioma: "Idioma",
    suporte: "Suporte",
    logout: "Sair",

    // Accounts
    "binance.spot": "Binance Spot",
    "binance.futures": "Binance Futures",
    agregado: "Agregado",

    // Languages
    portuguese: "Português",
    english: "Inglês",
    spanish: "Espanhol",

    // Login
    "sign.in": "Entrar",
    "enter.credentials": "Digite suas credenciais para acessar sua conta de trading",
    email: "Email",
    "enter.email": "Digite seu email",
    password: "Senha",
    "enter.password": "Digite sua senha",
    "email.required": "Email é obrigatório",
    "email.invalid": "Email é inválido",
    "password.required": "Senha é obrigatória",
    "password.min.length": "Senha deve ter pelo menos 6 caracteres",
    "remember.me": "Lembrar de mim",
    "forgot.password": "Esqueceu a senha?",
    "signing.in": "Entrando...",
    "no.account": "Não tem uma conta?",
    "contact.support": "Contate o suporte",
    "all.rights.reserved": "© 2024 Atius Capital. Todos os direitos reservados.",
    "secure.professional.reliable": "Seguro • Profissional • Confiável",
    "invalid.credentials": "Email ou senha inválidos. Tente admin@atiuscapital.com / password123",
  },

  en: {
    // Header
    "atius.capital": "Atius Capital",
    "professional.trading.platform": "Professional Trading Platform",

    // Dashboard
    "current.btc.price": "Current BTC Price",
    "portfolio.value": "Portfolio Value",
    "bot.status": "Bot Status",
    running: "Running",
    stopped: "Stopped",
    dashboard: "Dashboard",
    positions: "Positions",
    history: "History",
    settings: "Settings",

    // Trading Interface
    "manual.trading": "Manual Trading",
    "execute.trades": "Execute trades with different order types",
    "order.type": "Order Type",
    market: "Market",
    limit: "Limit",
    "stop.loss.market": "Stop Loss Market",
    "take.profit.market": "Take Profit Market",
    direction: "Direction",
    buy: "Buy",
    sell: "Sell",
    "limit.price": "Limit Price",
    "stop.price": "Stop Price",
    "take.profit.price": "Take Profit Price",
    "enter.limit.price": "Enter limit price",
    "enter.stop.price": "Enter stop price",
    "enter.take.profit.price": "Enter take profit price",
    size: "Size",
    "enter.size": "Enter size",
    "limit.only": "Limit Only",
    price: "Price",
    amount: "Amount",
    total: "Total",
    available: "Available",
    "buy.btc": "Buy BTC",
    "sell.btc": "Sell BTC",

    // Bot Settings
    "bot.configuration": "Bot Configuration",
    "configure.bot.parameters": "Configure your trading bot parameters",
    "trading.strategy": "Trading Strategy",
    "select.strategy": "Select strategy",
    "simple.momentum": "Simple Momentum",
    "macd.crossover": "MACD Crossover",
    "rsi.oversold.overbought": "RSI Oversold/Overbought",
    "max.risk": "Max Risk (%)",
    "enter.risk.percentage": "Enter risk percentage (1-10%)",
    "risk.recommendation": "Recommended: 1-5% for conservative, 5-10% for aggressive trading",
    "max.simultaneous.positions": "Max Simultaneous Positions",
    "select.max.positions": "Select max positions",
    position: "Position",
    positions: "Positions",
    "maximum.positions.help": "Maximum number of open positions at the same time",
    "start.bot": "Start Bot",
    "stop.bot": "Stop Bot",
    "current.configuration": "Current configuration and performance",
    strategy: "Strategy",
    "max.positions": "Max Positions",
    "performance.metrics": "Performance Metrics",
    "active.positions": "Active Positions",
    "total.trades": "Total Trades",
    "win.rate": "Win Rate",

    // Open Positions
    "open.positions": "Open Positions",
    "current.trading.positions": "Your current trading positions",
    "no.open.positions": "No open positions. Start trading to see your positions here.",
    long: "LONG",
    short: "SHORT",
    "entry.price": "Entry Price",
    "current.price": "Current Price",

    // Trade History
    "trade.history": "Trade History",
    "recent.trading.activity": "Your recent trading activity",
    "no.trades.yet": "No trades yet. Start trading to see your history.",

    // User Menu
    portfolio: "Portfolio",
    "usd.balance": "USD Balance",
    "btc.balance": "BTC Balance",
    perfil: "Profile",
    idioma: "Language",
    suporte: "Support",
    logout: "Logout",

    // Accounts
    "binance.spot": "Binance Spot",
    "binance.futures": "Binance Futures",
    agregado: "Aggregated",

    // Languages
    portuguese: "Portuguese",
    english: "English",
    spanish: "Spanish",

    // Login
    "sign.in": "Sign In",
    "enter.credentials": "Enter your credentials to access your trading account",
    email: "Email",
    "enter.email": "Enter your email",
    password: "Password",
    "enter.password": "Enter your password",
    "email.required": "Email is required",
    "email.invalid": "Email is invalid",
    "password.required": "Password is required",
    "password.min.length": "Password must be at least 6 characters",
    "remember.me": "Remember me",
    "forgot.password": "Forgot password?",
    "signing.in": "Signing in...",
    "no.account": "Don't have an account?",
    "contact.support": "Contact support",
    "all.rights.reserved": "© 2024 Atius Capital. All rights reserved.",
    "secure.professional.reliable": "Secure • Professional • Reliable",
    "invalid.credentials": "Invalid email or password. Try admin@atiuscapital.com / password123",
  },

  es: {
    // Header
    "atius.capital": "Atius Capital",
    "professional.trading.platform": "Plataforma de Trading Profesional",

    // Dashboard
    "current.btc.price": "Precio Actual de BTC",
    "portfolio.value": "Valor del Portafolio",
    "bot.status": "Estado del Bot",
    running: "Ejecutándose",
    stopped: "Detenido",
    dashboard: "Panel",
    positions: "Posiciones",
    history: "Historial",
    settings: "Configuración",

    // Trading Interface
    "manual.trading": "Trading Manual",
    "execute.trades": "Ejecuta operaciones con diferentes tipos de órdenes",
    "order.type": "Tipo de Orden",
    market: "Mercado",
    limit: "Límite",
    "stop.loss.market": "Stop Loss Market",
    "take.profit.market": "Take Profit Market",
    direction: "Dirección",
    buy: "Comprar",
    sell: "Vender",
    "limit.price": "Precio Límite",
    "stop.price": "Precio Stop",
    "take.profit.price": "Precio Take Profit",
    "enter.limit.price": "Ingrese precio límite",
    "enter.stop.price": "Ingrese precio stop",
    "enter.take.profit.price": "Ingrese precio take profit",
    size: "Tamaño",
    "enter.size": "Ingrese tamaño",
    "limit.only": "Solo Límite",
    price: "Precio",
    amount: "Cantidad",
    total: "Total",
    available: "Disponible",
    "buy.btc": "Comprar BTC",
    "sell.btc": "Vender BTC",

    // Bot Settings
    "bot.configuration": "Configuración del Bot",
    "configure.bot.parameters": "Configure los parámetros de su bot de trading",
    "trading.strategy": "Estrategia de Trading",
    "select.strategy": "Seleccione estrategia",
    "simple.momentum": "Momentum Simple",
    "macd.crossover": "Cruce MACD",
    "rsi.oversold.overbought": "RSI Sobrevendido/Sobrecomprado",
    "max.risk": "Riesgo Máximo (%)",
    "enter.risk.percentage": "Ingrese porcentaje de riesgo (1-10%)",
    "risk.recommendation": "Recomendado: 1-5% para conservador, 5-10% para agresivo",
    "max.simultaneous.positions": "Máximo de Posiciones Simultáneas",
    "select.max.positions": "Seleccione máximo de posiciones",
    position: "Posición",
    positions: "Posiciones",
    "maximum.positions.help": "Número máximo de posiciones abiertas al mismo tiempo",
    "start.bot": "Iniciar Bot",
    "stop.bot": "Detener Bot",
    "current.configuration": "Configuración actual y rendimiento",
    strategy: "Estrategia",
    "max.positions": "Máx. Posiciones",
    "performance.metrics": "Métricas de Rendimiento",
    "active.positions": "Posiciones Activas",
    "total.trades": "Total de Operaciones",
    "win.rate": "Tasa de Éxito",

    // Open Positions
    "open.positions": "Posiciones Abiertas",
    "current.trading.positions": "Sus posiciones de trading actuales",
    "no.open.positions": "No hay posiciones abiertas. Comience a operar para ver sus posiciones aquí.",
    long: "LARGO",
    short: "CORTO",
    "entry.price": "Precio de Entrada",
    "current.price": "Precio Actual",

    // Trade History
    "trade.history": "Historial de Operaciones",
    "recent.trading.activity": "Su actividad de trading reciente",
    "no.trades.yet": "Aún no hay operaciones. Comience a operar para ver su historial.",

    // User Menu
    portfolio: "Portafolio",
    "usd.balance": "Saldo USD",
    "btc.balance": "Saldo BTC",
    perfil: "Perfil",
    idioma: "Idioma",
    suporte: "Soporte",
    logout: "Cerrar Sesión",

    // Accounts
    "binance.spot": "Binance Spot",
    "binance.futures": "Binance Futures",
    agregado: "Agregado",

    // Languages
    portuguese: "Portugués",
    english: "Inglés",
    spanish: "Español",

    // Login
    "sign.in": "Iniciar Sesión",
    "enter.credentials": "Ingrese sus credenciales para acceder a su cuenta de trading",
    email: "Email",
    "enter.email": "Ingrese su email",
    password: "Contraseña",
    "enter.password": "Ingrese su contraseña",
    "email.required": "Email es requerido",
    "email.invalid": "Email es inválido",
    "password.required": "Contraseña es requerida",
    "password.min.length": "La contraseña debe tener al menos 6 caracteres",
    "remember.me": "Recordarme",
    "forgot.password": "¿Olvidó su contraseña?",
    "signing.in": "Iniciando sesión...",
    "no.account": "¿No tiene una cuenta?",
    "contact.support": "Contacte soporte",
    "all.rights.reserved": "© 2024 Atius Capital. Todos los derechos reservados.",
    "secure.professional.reliable": "Seguro • Profesional • Confiable",
    "invalid.credentials": "Email o contraseña inválidos. Pruebe admin@atiuscapital.com / password123",
  },
}

interface LanguageProviderProps {
  children: ReactNode
}

export function LanguageProvider({ children }: LanguageProviderProps) {
  const [language, setLanguageState] = useState<Language>("pt")

  useEffect(() => {
    const savedLanguage = localStorage.getItem("atius-language") as Language
    if (savedLanguage && ["pt", "en", "es"].includes(savedLanguage)) {
      setLanguageState(savedLanguage)
    }
  }, [])

  const setLanguage = (lang: Language) => {
    setLanguageState(lang)
    localStorage.setItem("atius-language", lang)
  }

  const t = (key: string): string => {
    return translations[language][key] || key
  }

  return <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>
}
