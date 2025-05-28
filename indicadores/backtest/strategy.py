# strategy.py
# Estratégia Inception adaptada do PineScript para Python

import streamlit as st
import ccxt
import pandas as pd
import vectorbt as vbt
import plotly.graph_objects as go
import requests
import datetime
from vectorbt.indicators.basic import MA, RSI

# Contador global para gerar chaves únicas
key_counter = 0

# Clear cache
st.cache_data.clear()
st.cache_resource.clear()

# ===== Sidebar Configuration =====
st.sidebar.title("Configurações da Estratégia")

# API Keys configuradas diretamente no código
api_key = "Zp2jBR9J74j6tCd2YJ3w15ODOCTMIv9yu4hIDLu3FVYUyZKewrbn7NyaYsu2Okm5"
api_secret = "gWwsrlBdBUfCztWISaXGssrOQSaRIDvrqDPL71id1ymqHTssQgTUaroEi9RDzTty"

# Configurações de trading
symbol = st.sidebar.text_input("Símbolo", value="BTC/USDT")
timeframe = st.sidebar.selectbox(
    "Timeframe", ["1m", "5m", "15m", "1h", "4h", "1d"], index=2
)

# Seletor de período de data
hoje = datetime.datetime.now()
um_ano_atras = hoje - datetime.timedelta(days=365)

col1, col2 = st.sidebar.columns(2)
with col1:
    data_inicio = st.date_input("Data Inicial", value=um_ano_atras)
with col2:
    data_fim = st.date_input("Data Final", value=hoje)

# Strategy parameters - AJUSTADOS CONFORME PINESCRIPT
rsi_len = 14
ema_len = 50
vol_sma_len = 20
pivot_left = 1
pivot_right = 2
vol_multiplier = 1.0

# Extensão de Fibonacci AJUSTADA para 0.618 como no PineScript
fib_ext = 0.618

# Configurações de Capital e Taxas
st.sidebar.markdown("---")
st.sidebar.subheader("Capital e Taxas")
capital_inicial = st.sidebar.number_input("Capital", value=1000.0, min_value=100.0, step=100.0, help="Capital inicial em USDT")
entrada = st.sidebar.number_input("Entrada", value=250.0, min_value=10.0, step=50.0, help="Valor de entrada por operação em USDT")
taxa = st.sidebar.number_input("Taxa", value=0.05, min_value=0.0, max_value=1.0, step=0.01, format="%.2f", help="Taxa de corretagem em %")

# AJUSTADO conforme PineScript
leverage = 125
entry_percent = 25  # 25% do capital

st.sidebar.markdown("---")
st.sidebar.write("### Webhook (Live)")
webhook_url = st.sidebar.text_input(
    "Webhook URL", value="https://api.atius.com.br/webhook"
)

# Bearer token conforme PineScript
bearer_token = "fd23e8ae1c1c4d78c5092ff6db6f79a00e1f0d4dba3a8ea0ddd318b6a01647ba"

# ===== Fetch OHLCV Data =====
def fetch_ohlcv(exchange, symbol, timeframe, since, until):
    # Converter datas para timestamp em milissegundos
    since_ts = int(datetime.datetime.combine(since, datetime.time.min).timestamp() * 1000)
    until_ts = int(datetime.datetime.combine(until, datetime.time.max).timestamp() * 1000)

    # Inicializar lista vazia para armazenar os candles
    all_candles = []

    # Definir o timestamp atual como o timestamp inicial
    current_ts = since_ts

    # Loop para buscar todos os candles entre since_ts e until_ts
    while current_ts < until_ts:
        try:
            # Buscar candles a partir do timestamp atual
            candles = exchange.fetch_ohlcv(
                symbol,
                timeframe=timeframe,
                since=current_ts,
                limit=1000  # CCXT geralmente limita a 1000 candles por chamada
            )

            if not candles:
                break

            # Adicionar candles à lista
            all_candles.extend(candles)

            # Atualizar o timestamp atual para o próximo lote
            current_ts = candles[-1][0] + 1

            # Verificar se chegamos ao final do período
            if current_ts >= until_ts:
                break
        except Exception as e:
            st.error(f"Erro ao buscar dados: {e}")
            break

    # Converter para DataFrame
    if not all_candles:
        st.error(f"Nenhum dado encontrado para {symbol} no período selecionado.")
        return pd.DataFrame()

    df = pd.DataFrame(all_candles, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
    df.set_index("timestamp", inplace=True)

    # Filtrar apenas o período desejado (garantia extra)
    df = df[(df.index >= pd.Timestamp(since)) & (df.index <= pd.Timestamp(until))]

    return df

# Funções auxiliares
def convert_timedeltas(df):
    """Converte objetos Timedelta para string para compatibilidade com PyArrow"""
    for col in df.columns:
        if df[col].dtype == 'object':
            df[col] = df[col].apply(lambda x: str(x) if hasattr(x, 'total_seconds') else x)
    return df

def colored_value(value, threshold=0, positive_color="green", negative_color="red"):
    """Retorna um texto HTML com a cor apropriada baseada no valor"""
    color = positive_color if value >= threshold else negative_color
    value_formatted = f"{value:.2f}" if isinstance(value, (float, int)) else value
    return f"<span style='color:{color};font-weight:bold'>{value_formatted}</span>"

def format_df_numbers(df):
    """Formata todos os valores numéricos em um DataFrame para ter 2 casas decimais"""
    formatted_df = df.copy()
    for col in formatted_df.columns:
        if formatted_df[col].dtype in ['float64', 'float32']:
            formatted_df[col] = formatted_df[col].apply(lambda x: f"{x:.2f}")
    return formatted_df

# Mostrar indicador de progresso enquanto busca dados
with st.spinner('Buscando dados históricos...'):
    exchange = ccxt.binanceusdm({
        "apiKey": api_key,
        "secret": api_secret,
        "enableRateLimit": True
    })

    # Futuros perpétuos precisam terminar com ":USDT" em alguns casos ou ser modificados
    if ":" not in symbol and exchange.id == "binanceusdm":
        clean_symbol = symbol.replace("/", "")
        st.info(f"Símbolo convertido para formato de futuros: {clean_symbol}")
        symbol = clean_symbol

    # Buscar dados com base no período selecionado
    df = fetch_ohlcv(exchange, symbol, timeframe, data_inicio, data_fim)

# Verificar se temos dados para continuar
if df.empty:
    st.warning("Não foi possível obter dados para realizar a análise.")
    st.stop()

# ===== Indicators =====
df["EMA50"] = MA.run(df["close"], window=ema_len, ewm=True).ma
df["RSI"] = RSI.run(df["close"], window=rsi_len).rsi
df["VolSMA"] = df["volume"].rolling(vol_sma_len).mean()

# ===== Pivot Detection =====
window = pivot_left + pivot_right + 1

# centro do pivô
pivot_low_center  = df['low']  == df['low'].rolling(window, center=True).min()
pivot_high_center = df['high'] == df['high'].rolling(window, center=True).max()

# Usar astype(bool) após fillna para evitar avisos
df['pivot_low']   = pivot_low_center.shift(pivot_right).fillna(False).astype(bool)
df['pivot_high']  = pivot_high_center.shift(pivot_right).fillna(False).astype(bool)

# preço/RSI do pivô já alinhados
df['pl_price'] = df['low' ].where(pivot_low_center ).shift(pivot_right)
df['pl_rsi']   = df['RSI' ].where(pivot_low_center ).shift(pivot_right)
df['ph_price'] = df['high'].where(pivot_high_center).shift(pivot_right)
df['ph_rsi']   = df['RSI' ].where(pivot_high_center).shift(pivot_right)

# ===== IMPLEMENTAÇÃO ALINHADA COM PINESCRIPT =====
# Armazenamento de pivôs
# Iniciamos com NaN para todas as variáveis
var_pivot_low_price1 = pd.Series(float('nan'), index=df.index)
var_pivot_low_price2 = pd.Series(float('nan'), index=df.index)
var_pivot_low_rsi1 = pd.Series(float('nan'), index=df.index)
var_pivot_low_rsi2 = pd.Series(float('nan'), index=df.index)

var_pivot_high_price1 = pd.Series(float('nan'), index=df.index)
var_pivot_high_price2 = pd.Series(float('nan'), index=df.index)
var_pivot_high_rsi1 = pd.Series(float('nan'), index=df.index)
var_pivot_high_rsi2 = pd.Series(float('nan'), index=df.index)

# Crie Series para bull_div e bear_div
bull_div = pd.Series(False, index=df.index)
bear_div = pd.Series(False, index=df.index)

# Iterar pelo DataFrame como feito no PineScript
for i in range(len(df)):
    # Para pivôs de baixa (lows)
    if i > 0 and df['pivot_low'].iloc[i]:
        # Mover valores do pivô anterior
        var_pivot_low_price2.iloc[i] = var_pivot_low_price1.iloc[i-1]
        var_pivot_low_rsi2.iloc[i] = var_pivot_low_rsi1.iloc[i-1]

        # Atualizar com valores do novo pivô
        var_pivot_low_price1.iloc[i] = df['low'].iloc[i]
        var_pivot_low_rsi1.iloc[i] = df['RSI'].iloc[i]
    else:
        # Manter valores anteriores
        if i > 0:
            var_pivot_low_price1.iloc[i] = var_pivot_low_price1.iloc[i-1]
            var_pivot_low_price2.iloc[i] = var_pivot_low_price2.iloc[i-1]
            var_pivot_low_rsi1.iloc[i] = var_pivot_low_rsi1.iloc[i-1]
            var_pivot_low_rsi2.iloc[i] = var_pivot_low_rsi2.iloc[i-1]

    # Para pivôs de alta (highs)
    if i > 0 and df['pivot_high'].iloc[i]:
        # Mover valores do pivô anterior
        var_pivot_high_price2.iloc[i] = var_pivot_high_price1.iloc[i-1]
        var_pivot_high_rsi2.iloc[i] = var_pivot_high_rsi1.iloc[i-1]

        # Atualizar com valores do novo pivô
        var_pivot_high_price1.iloc[i] = df['high'].iloc[i]
        var_pivot_high_rsi1.iloc[i] = df['RSI'].iloc[i]
    else:
        # Manter valores anteriores
        if i > 0:
            var_pivot_high_price1.iloc[i] = var_pivot_high_price1.iloc[i-1]
            var_pivot_high_price2.iloc[i] = var_pivot_high_price2.iloc[i-1]
            var_pivot_high_rsi1.iloc[i] = var_pivot_high_rsi1.iloc[i-1]
            var_pivot_high_rsi2.iloc[i] = var_pivot_high_rsi2.iloc[i-1]

    # Verificar divergência de alta (bullish)
    if (i > 0 and
        df['pivot_low'].iloc[i] and
        not pd.isna(var_pivot_low_price1.iloc[i]) and
        not pd.isna(var_pivot_low_price2.iloc[i]) and
        var_pivot_low_price1.iloc[i] < var_pivot_low_price2.iloc[i] and
        var_pivot_low_rsi1.iloc[i] > var_pivot_low_rsi2.iloc[i]):
        bull_div.iloc[i] = True

    # Verificar divergência de baixa (bearish)
    if (i > 0 and
        df['pivot_high'].iloc[i] and
        not pd.isna(var_pivot_high_price1.iloc[i]) and
        not pd.isna(var_pivot_high_price2.iloc[i]) and
        var_pivot_high_price1.iloc[i] > var_pivot_high_price2.iloc[i] and
        var_pivot_high_rsi1.iloc[i] < var_pivot_high_rsi2.iloc[i]):
        bear_div.iloc[i] = True

# ===== Trend and Volume Filter =====
long_trend = df['close'] > df['EMA50']
short_trend = df['close'] < df['EMA50']
enough_vol = df['volume'] > df['VolSMA'] * vol_multiplier

# ===== Condições de Entrada (como no PineScript) =====
entries_long = bull_div & long_trend & enough_vol
entries_short = bear_div & short_trend & enough_vol

# ===== Stop/TP no último pivô =====
sl_long = var_pivot_low_price1  # stop no pivô de baixa
distance_long = df['close'] - sl_long
tp_long = df['close'] + (distance_long * fib_ext)  # TP baseado na extensão de Fibonacci

sl_short = var_pivot_high_price1  # stop no pivô de alta
distance_short = sl_short - df['close']
tp_short = df['close'] - (distance_short * fib_ext)  # TP baseado na extensão de Fibonacci

# Antes do backtest: verificar mudanças no fib_ext
if 'last_fib_ext' not in st.session_state:
    st.session_state.last_fib_ext = fib_ext

fib_ext_changed = st.session_state.last_fib_ext != fib_ext
if fib_ext_changed:
    st.cache_data.clear()
    st.cache_resource.clear()
    st.info(f"Extensão Fibonacci alterada de {st.session_state.last_fib_ext:.3f} para {fib_ext:.3f}. Recalculando backtest...")
    st.session_state.last_fib_ext = fib_ext
    key_counter += 1

# ===== Diagnóstico =====
st.subheader("Diagnóstico")
col1, col2, col3, col4, col5 = st.columns(5)
with col1:
    st.metric("Total de candles", len(df))
with col2:
    st.metric("Pivôs de baixa", f"{int(df['pivot_low'].sum())}")
with col3:
    st.metric("Pivôs de alta", f"{int(df['pivot_high'].sum())}")
with col4:
    st.metric("Potenciais entradas", f"{int(entries_long.sum() + entries_short.sum())}")
with col5:
    st.metric("Extensão Fibonacci", f"{fib_ext}")

# Função de backtest com cache
@st.cache_resource(ttl=60, max_entries=2)
def run_backtest(df, entries_long, entries_short, sl_long, sl_short, tp_long, tp_short, capital_inicial, entrada, taxa, fib_ext):
    """Executa o backtest com os parâmetros fornecidos."""
    return vbt.Portfolio.from_signals(
        close          = df['close'],
        entries        = entries_long,
        exits          = entries_short,
        short_entries  = entries_short,
        short_exits    = entries_long,
        sl_stop        = sl_long.combine_first(sl_short),
        tp_stop        = tp_long.combine_first(tp_short),
        init_cash      = capital_inicial,
        size=entrada / df['close'],
        fees           = taxa / 100
    )

# Tentar executar o backtest
try:
    # Executar backtest usando a função com cache
    pf = run_backtest(df, entries_long, entries_short,
                      sl_long, sl_short, tp_long, tp_short,
                      capital_inicial, entrada, taxa, fib_ext + (key_counter * 0.0000001))

    # Cálculo de métricas
    total_return = pf.total_return()
    total_trades = len(pf.trades)
    trades_open = len(pf.trades.open)
    total_trades_with_open = total_trades + trades_open
    pnl_dollars = pf.total_profit()
    max_dd = pf.max_drawdown()
    max_dd_pct = pf.max_drawdown() / capital_inicial * 100
    win_rate = pf.trades.win_rate() * 100 if total_trades > 0 else 0
    profit_factor = pf.trades.profit_factor() if total_trades > 0 else 0

    # Exibição de resultados do backtest
    st.header("⚙️ Performance do Backtest")

    # Formatar valores com cores personalizadas
    pnl_color = "limegreen" if pnl_dollars >= 0 else "crimson"
    winrate_color = "limegreen" if win_rate >= 50 else "crimson"
    profit_factor_color = "limegreen" if profit_factor >= 1 else "crimson"

    # Criar HTML personalizado para os resultados
    results_html = f"""
    <div style="display:flex;flex-wrap:wrap;gap:20px">
      <div style="flex:1;min-width:200px;padding:10px;border:1px solid #ddd;border-radius:5px">
        <div style="font-size:14px;color:#888">Lucro/Prejuízo Total</div>
        <div style="font-size:18px;font-weight:bold;color:{pnl_color}">${pnl_dollars:.2f} ({(total_return*100):.2f}%)</div>
      </div>
      <div style="flex:1;min-width:200px;padding:10px;border:1px solid #ddd;border-radius:5px">
        <div style="font-size:14px;color:#888">Máxima Queda</div>
        <div style="font-size:18px;font-weight:bold;color:orange">${max_dd:.2f} ({max_dd_pct:.2f}%)</div>
      </div>
      <div style="flex:1;min-width:200px;padding:10px;border:1px solid #ddd;border-radius:5px">
        <div style="font-size:14px;color:#888">Total Negociações</div>
        <div style="font-size:18px;font-weight:bold">{total_trades_with_open} (incl. {trades_open} abertas)</div>
      </div>
      <div style="flex:1;min-width:200px;padding:10px;border:1px solid #ddd;border-radius:5px">
        <div style="font-size:14px;color:#888">Negociações Lucrativas</div>
        <div style="font-size:18px;font-weight:bold;color:{winrate_color}">{win_rate:.2f}%</div>
      </div>
      <div style="flex:1;min-width:200px;padding:10px;border:1px solid #ddd;border-radius:5px">
        <div style="font-size:14px;color:#888">Fator de Lucro</div>
        <div style="font-size:18px;font-weight:bold;color:{profit_factor_color}">{profit_factor:.2f}</div>
      </div>
    </div>
    """

    # Exibir resultados e gráficos
    st.markdown(results_html, unsafe_allow_html=True)

    # Estatísticas gerais e gráficos
    st.subheader("Estatísticas Gerais")
    stats_df = convert_timedeltas(pf.stats().to_frame(name="Value"))
    stats_df_formatted = format_df_numbers(stats_df)
    st.dataframe(stats_df_formatted)

    # Curva de patrimônio
    st.subheader("Curva de Patrimônio")
    pf_fig = pf.plot()
    st.plotly_chart(pf_fig, use_container_width=True)

except Exception as e:
    st.error(f"Erro ao calcular estatísticas do backtest: {str(e)}")

# ===== Gráfico de Preço com Sinais =====
st.header("📈 Gráfico de Preço + Sinais")
fig = go.Figure()
fig.add_trace(go.Candlestick(
    x=df.index,
    open=df["open"],
    high=df["high"],
    low=df["low"],
    close=df["close"],
    name="Preço"
))
fig.add_trace(go.Scatter(
    x=df.index,
    y=df["EMA50"],
    mode="lines",
    name="EMA50"
))
long_pts = df.loc[entries_long]
if not long_pts.empty:
    fig.add_trace(go.Scatter(
        x=long_pts.index,
        y=long_pts["low"] * 0.995,
        mode="markers",
        marker_symbol="triangle-up",
        marker_size=12,
        marker_color="white",  # Cor branca como no PineScript
        name="Compra"
    ))
short_pts = df.loc[entries_short]
if not short_pts.empty:
    fig.add_trace(go.Scatter(
        x=short_pts.index,
        y=short_pts["high"] * 1.005,
        mode="markers",
        marker_symbol="triangle-down",
        marker_size=12,
        marker_color="yellow",  # Cor amarela como no PineScript
        name="Venda"
    ))

# Mostrar pivôs detectados
fig.add_trace(go.Scatter(
    x=df.loc[df['pivot_low']].index,
    y=df.loc[df['pivot_low']]['low'],
    mode="markers",
    marker_symbol="circle",
    marker_size=8,
    marker_color="lime",
    name="Pivôs Baixa"
))
fig.add_trace(go.Scatter(
    x=df.loc[df['pivot_high']].index,
    y=df.loc[df['pivot_high']]['high'],
    mode="markers",
    marker_symbol="circle",
    marker_size=8,
    marker_color="red",
    name="Pivôs Alta"
))

# Opção para mostrar Stop Loss e Take Profit
show_stops = st.checkbox("Mostrar Stop Loss e Take Profit", value=False)

if show_stops and not df.empty:
    # Para pontos de entrada long, mostrar SL e TP
    long_entries = df.loc[entries_long]
    if not long_entries.empty:
        fig.add_trace(go.Scatter(
            x=long_entries.index,
            y=long_entries['pl_price'],
            mode="markers",
            marker_symbol="circle",
            marker_size=8,
            marker_color="red",
            name="Stop Loss (Long)"
        ))
        fig.add_trace(go.Scatter(
            x=long_entries.index,
            y=long_entries['close'] + (long_entries['close'] - long_entries['pl_price']) * fib_ext,
            mode="markers",
            marker_symbol="circle",
            marker_size=8,
            marker_color="green",
            name=f"Take Profit (Long, {fib_ext:.3f})"
        ))

    # Para pontos de entrada short, mostrar SL e TP
    short_entries = df.loc[entries_short]
    if not short_entries.empty:
        fig.add_trace(go.Scatter(
            x=short_entries.index,
            y=short_entries['ph_price'],
            mode="markers",
            marker_symbol="circle",
            marker_size=8,
            marker_color="red",
            name="Stop Loss (Short)"
        ))
        fig.add_trace(go.Scatter(
            x=short_entries.index,
            y=short_entries['close'] - (short_entries['ph_price'] - short_entries['close']) * fib_ext,
            mode="markers",
            marker_symbol="circle",
            marker_size=8,
            marker_color="green",
            name=f"Take Profit (Short, {fib_ext:.3f})"
        ))

fig.update_layout(xaxis_rangeslider_visible=False, height=500)
st.plotly_chart(fig, use_container_width=True)

# ===== RSI Subplot =====
st.header("RSI (14)")
fig_rsi = go.Figure()
fig_rsi.add_trace(go.Scatter(x=df.index, y=df["RSI"], mode="lines"))
fig_rsi.update_layout(yaxis=dict(range=[0,100]), height=200)
st.plotly_chart(fig_rsi, use_container_width=True)

# ===== Envio de Webhook (formato alinhado com PineScript) =====
st.header("🔔 Envio de Sinal (Ao Vivo)")
if st.button("Gerar e Enviar Último Sinal"):
    side = None
    entry = df["close"].iloc[-1]

    if entries_long.iloc[-1]:
        side = "buy"
        sl = sl_long.iloc[-1]
        tp = tp_long.iloc[-1]
        messageType = "new_trade_long"
    elif entries_short.iloc[-1]:
        side = "sell"
        sl = sl_short.iloc[-1]
        tp = tp_short.iloc[-1]
        messageType = "new_trade_short"

    if side:
        side_display = "COMPRA" if side == "buy" else "VENDA"
        trade_id = str(int(df.index[-1].timestamp()))

        # Ajuste de preço conforme PineScript
        adjustedEntryPrice = entry * 0.996 if side == "buy" else entry * 1.002

        # Formato alinhado com PineScript
        webhook_payload = {
            "alert": {
                "message": {
                    "id": trade_id,
                    "symbol": symbol,
                    "side": side,
                    "leverage": leverage,
                    "capital": entry_percent,
                    "entry": float(f"{adjustedEntryPrice:.2f}"),
                    "tp": float(f"{tp:.2f}"),
                    "sl": float(f"{sl:.2f}"),
                    "message_type": messageType
                },
                "headers": {
                    "Authorization": f"Bearer {bearer_token}"
                }
            }
        }

        res = requests.post(webhook_url, json=webhook_payload)
        if res.ok:
            st.success(f"Sinal {side_display} enviado com sucesso!")
        else:
            st.error(f"Falha ao enviar sinal: {res.status_code}")
    else:
        st.info("Nenhum sinal gerado na última vela.")