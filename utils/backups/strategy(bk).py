# app.py
# Unified Streamlit app for Inception strategy using ccxt + vectorbt
# Requirements: streamlit, ccxt, pandas, vectorbt, plotly, requests

import streamlit as st
import ccxt
import pandas as pd
import vectorbt as vbt
import plotly.graph_objects as go
import requests
import datetime
from vectorbt.indicators.basic import MA, RSI

# Adicione no início do script, logo após os imports:
key_counter = 0  # Contador global para gerar chaves únicas

# Clear cache
st.cache_data.clear()  # Limpa qualquer cache existente
st.cache_resource.clear()  # Limpa recursos em cache

# ===== Sidebar Configuration =====
st.sidebar.title("Configurações da Estratégia")

# API Keys configuradas diretamente no código ao invés de no sidebar
api_key = "Zp2jBR9J74j6tCd2YJ3w15ODOCTMIv9yu4hIDLu3FVYUyZKewrbn7NyaYsu2Okm5"
api_secret = "gWwsrlBdBUfCztWISaXGssrOQSaRIDvrqDPL71id1ymqHTssQgTUaroEi9RDzTty"

# Configurações de trading
symbol = st.sidebar.text_input("Símbolo", value="BTC/USDT")
timeframe = st.sidebar.selectbox(
    "Timeframe", ["1m", "5m", "15m", "1h", "4h", "1d"], index=2  # índice 2 é o timeframe 15m
)

# Seletor de período de data
hoje = datetime.datetime.now()
um_ano_atras = hoje - datetime.timedelta(days=365)

col1, col2 = st.sidebar.columns(2)
with col1:
    data_inicio = st.date_input("Data Inicial", value=um_ano_atras)
with col2:
    data_fim = st.date_input("Data Final", value=hoje)

# Strategy parameters
rsi_len = 14
ema_len = 50
vol_sma_len = 20
pivot_left = 1
pivot_right = 2
vol_multiplier = 1.0

# Extensão de Fibonacci fixa
fib_ext = 1.0  # Valor fixo sem opção de alteração pelo usuário

# Configurações de Capital e Taxas
st.sidebar.markdown("---")
st.sidebar.subheader("Capital e Taxas")
capital_inicial = st.sidebar.number_input("Capital", value=1000.0, min_value=100.0, step=100.0, help="Capital inicial em USDT")
entrada = st.sidebar.number_input("Entrada", value=500.0, min_value=10.0, step=50.0, help="Valor de entrada por operação em USDT")
taxa = st.sidebar.number_input("Taxa", value=0.05, min_value=0.0, max_value=1.0, step=0.01, format="%.2f", help="Taxa de corretagem em %")

leverage = 30
entry_percent = entrada / capital_inicial  # Percentual de entrada calculado

st.sidebar.markdown("---")
st.sidebar.write("### Webhook (Live)")
webhook_url = st.sidebar.text_input(
    "Webhook URL", value="https://api.atius.com.br/webhook"
)

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

# Função para converter timedeltas para strings (para corrigir o erro do PyArrow)
def convert_timedeltas(df):
    """Converte objetos Timedelta para string para compatibilidade com PyArrow"""
    for col in df.columns:
        if df[col].dtype == 'object':
            df[col] = df[col].apply(lambda x: str(x) if hasattr(x, 'total_seconds') else x)
    return df

# Função para formatar valores com cores personalizadas
def colored_value(value, threshold=0, positive_color="green", negative_color="red"):
    """Retorna um texto HTML com a cor apropriada baseada no valor"""
    color = positive_color if value >= threshold else negative_color
    # Garantir sempre 2 casas decimais
    value_formatted = f"{value:.2f}" if isinstance(value, (float, int)) else value
    return f"<span style='color:{color};font-weight:bold'>{value_formatted}</span>"

# Função para formatar todos os valores numéricos de um DataFrame
def format_df_numbers(df):
    """Formata todos os valores numéricos em um DataFrame para ter 2 casas decimais"""
    formatted_df = df.copy()
    for col in formatted_df.columns:
        if formatted_df[col].dtype in ['float64', 'float32']:
            formatted_df[col] = formatted_df[col].apply(lambda x: f"{x:.2f}")
    return formatted_df

# Mostrar indicador de progresso enquanto busca dados
with st.spinner('Buscando dados históricos...'):
    # Usar binanceusdm em vez de binance para acessar o mercado de futuros
    exchange = ccxt.binanceusdm({
        "apiKey": api_key,
        "secret": api_secret,
        "enableRateLimit": True
    })

    # Futuros perpétuos precisam terminar com ":USDT" em alguns casos ou ser modificados
    if ":" not in symbol and exchange.id == "binanceusdm":
        # Exemplo: converter "BTC/USDT" para "BTCUSDT"
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

# ===== Pivot Detection =====
window = pivot_left + pivot_right + 1

# centro do pivô
pivot_low_center  = df['low']  == df['low'].rolling(window, center=True).min()
pivot_high_center = df['high'] == df['high'].rolling(window, center=True).max()

# CORREÇÃO: Usar astype(bool) após fillna para evitar avisos
df['pivot_low']   = pivot_low_center.shift(pivot_right).fillna(False).astype(bool)
df['pivot_high']  = pivot_high_center.shift(pivot_right).fillna(False).astype(bool)

# preço/RSI do pivô já alinhados
df['pl_price'] = df['low' ].where(pivot_low_center ).shift(pivot_right)
df['pl_rsi']   = df['RSI' ].where(pivot_low_center ).shift(pivot_right)
df['ph_price'] = df['high'].where(pivot_high_center).shift(pivot_right)
df['ph_rsi']   = df['RSI' ].where(pivot_high_center).shift(pivot_right)

# ===== Trend and Volume Filter =====
vol_sma   = df['volume'].rolling(vol_sma_len).mean()
enough_vol = df['volume'] > (vol_sma * vol_multiplier)
long_trend  = df['close'] > df['EMA50']
short_trend = df['close'] < df['EMA50']

# ===== NOVA IMPLEMENTAÇÃO DA DIVERGÊNCIA =====
# Implementação alinhada com PineScript

# 1. Criamos Series para armazenar os sinais de divergência
bull_div = pd.Series(False, index=df.index)
bear_div = pd.Series(False, index=df.index)

# 2. Iteramos pelo DataFrame para encontrar as divergências
# Assim como o PineScript faz, mantemos os dois últimos pivôs
last_pivot_low_price = None
prev_pivot_low_price = None
last_pivot_low_rsi = None
prev_pivot_low_rsi = None

last_pivot_high_price = None
prev_pivot_high_price = None
last_pivot_high_rsi = None
prev_pivot_high_rsi = None

for i in range(window, len(df)):
    # Verificar se é um pivô de baixa
    if df['pivot_low'].iloc[i]:
        # Guardar o pivô anterior
        prev_pivot_low_price = last_pivot_low_price
        prev_pivot_low_rsi = last_pivot_low_rsi

        # Atualizar com o pivô atual
        last_pivot_low_price = df['low'].iloc[i]
        last_pivot_low_rsi = df['RSI'].iloc[i]

        # Verificar divergência se tivermos dois pivôs
        if (prev_pivot_low_price is not None and
            last_pivot_low_price < prev_pivot_low_price and
            last_pivot_low_rsi > prev_pivot_low_rsi):
            bull_div.iloc[i] = True

    # Verificar se é um pivô de alta
    if df['pivot_high'].iloc[i]:
        # Guardar o pivô anterior
        prev_pivot_high_price = last_pivot_high_price
        prev_pivot_high_rsi = last_pivot_high_rsi

        # Atualizar com o pivô atual
        last_pivot_high_price = df['high'].iloc[i]
        last_pivot_high_rsi = df['RSI'].iloc[i]

        # Verificar divergência se tivermos dois pivôs
        if (prev_pivot_high_price is not None and
            last_pivot_high_price > prev_pivot_high_price and
            last_pivot_high_rsi < prev_pivot_high_rsi):
            bear_div.iloc[i] = True

# 3. Aplicar os mesmos filtros de tendência e volume
entries_long = bull_div & long_trend & enough_vol
entries_short = bear_div & short_trend & enough_vol

# Antes do backtest:
# Armazenar o último valor de fib_ext usado
if 'last_fib_ext' not in st.session_state:
    st.session_state.last_fib_ext = fib_ext

# Verificar se houve mudança no fib_ext
fib_ext_changed = st.session_state.last_fib_ext != fib_ext
if fib_ext_changed:
    # Força limpeza do cache quando o valor muda
    st.cache_data.clear()
    st.cache_resource.clear()
    st.info(f"Extensão Fibonacci alterada de {st.session_state.last_fib_ext:.3f} para {fib_ext:.3f}. Recalculando backtest...")
    st.session_state.last_fib_ext = fib_ext
    # Incrementar o contador para forçar um recálculo
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
    st.metric("Extensão Fibonacci", "1.0")

# ===== Stop/TP no último pivô =====
sl_long = df['pl_price']   # stop é o preço do pivô low
distance_long = df['close'] - sl_long
tp_long = df['close'] + (distance_long * fib_ext)  # TP baseado na extensão de Fibonacci

sl_short = df['ph_price']   # stop é o preço do pivô high
distance_short = sl_short - df['close']
tp_short = df['close'] - (distance_short * fib_ext)  # TP baseado na extensão de Fibonacci

# Adicionar uma chave de cache baseada no valor de fib_ext
@st.cache_resource(ttl=60, max_entries=2)  # Usar cache_resource em vez de cache_data
def run_backtest(df, entries_long, entries_short, sl_long, sl_short, tp_long, tp_short, capital_inicial, entrada, taxa, fib_ext):
    """
    Executa o backtest com os parâmetros fornecidos.
    A inclusão do fib_ext como parâmetro força o recálculo quando este valor muda.
    """
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

# ===== Backtest with vectorbt and SL/TP =====
try:
    # Armazenar o último valor de fib_ext
    if 'last_fib_ext' not in st.session_state:
        st.session_state.last_fib_ext = fib_ext

    # Verificar se houve mudança no fib_ext
    fib_ext_changed = st.session_state.last_fib_ext != fib_ext

    if fib_ext_changed:
        # Força limpeza do cache quando o valor muda
        st.cache_data.clear()
        st.cache_resource.clear()
        st.info(f"Extensão Fibonacci alterada de {st.session_state.last_fib_ext:.3f} para {fib_ext:.3f}. Recalculando backtest...")
        st.session_state.last_fib_ext = fib_ext
        # Incrementar o contador para forçar um recálculo
        key_counter += 1

    # Calcular TP/SL usando a extensão de Fibonacci atual
    sl_long = df['pl_price']
    distance_long = df['close'] - sl_long
    tp_long = df['close'] + (distance_long * fib_ext)

    sl_short = df['ph_price']
    distance_short = sl_short - df['close']
    tp_short = df['close'] - (distance_short * fib_ext)

    # Executar backtest usando a função com cache e fib_ext como parâmetro
    pf = run_backtest(df, entries_long, entries_short,
                      sl_long, sl_short, tp_long, tp_short,
                      capital_inicial, entrada, taxa, fib_ext + (key_counter * 0.0000001))  # Adicionar um valor mínimo para mudar o hash

    # Resto do código permanece igual...
    total_return = pf.total_return()
    total_trades = len(pf.trades)
    trades_open = len(pf.trades.open)
    total_trades_with_open = total_trades + trades_open
    pnl_dollars = pf.total_profit()
    max_dd = pf.max_drawdown()
    max_dd_pct = pf.max_drawdown() / capital_inicial * 100
    win_rate = pf.trades.win_rate() * 100 if total_trades > 0 else 0
    profit_factor = pf.trades.profit_factor() if total_trades > 0 else 0

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

    # Exibir HTML personalizado
    st.markdown(results_html, unsafe_allow_html=True)

    st.subheader("Estatísticas Gerais")
    stats_df = convert_timedeltas(pf.stats().to_frame(name="Value"))
    stats_df_formatted = format_df_numbers(stats_df)
    st.dataframe(stats_df_formatted)

    # Lista de negociações
    st.subheader("Lista de Negociações")
    try:
        # Obter todas as negociações (fechadas e abertas)
        trades_closed = pf.trades.records
        trades_open = pf.trades.open

        st.write(f"Colunas disponíveis em trades_closed: {list(trades_closed.columns) if isinstance(trades_closed, pd.DataFrame) and not trades_closed.empty else 'DataFrame vazio'}")
        st.write(f"Tipo de trades_open: {type(trades_open).__name__}")
        try:
            if hasattr(trades_open, 'count') and callable(trades_open.count):
                st.write(f"Número de trades abertos: {trades_open.count()}")
            elif hasattr(trades_open, '__len__'):
                st.write(f"Número de trades abertos: {len(trades_open)}")
        except Exception as e:
            st.write(f"Não foi possível determinar o número de trades abertos: {str(e)}")

        trades_closed_has_data = isinstance(trades_closed, pd.DataFrame) and not trades_closed.empty
        trades_open_has_data = (
            (isinstance(trades_open, pd.DataFrame) and not trades_open.empty) or
            (hasattr(trades_open, 'count') and trades_open.count() > 0) or
            (hasattr(trades_open, '__len__') and len(trades_open) > 0)
        )

        if trades_closed_has_data or trades_open_has_data:
            # Criamos um DataFrame expandido onde cada trade terá uma ou duas linhas
            trades_expanded = []
            running_pnl = 0.0
            trade_num = 1

            # Processar negociações fechadas
            if trades_closed_has_data:
                # Verificar se a coluna 'exit_time' existe antes de ordenar
                if 'exit_time' in trades_closed.columns:
                    trades_sorted = trades_closed.sort_values('entry_idx', ascending=True).copy()
                # Se não houver coluna exit_time, tentar ordenar por exit_idx
                elif 'exit_idx' in trades_closed.columns:
                    trades_sorted = trades_closed.sort_values('entry_idx', ascending=True).copy()
                else:
                    trades_sorted = trades_closed.copy()

                trades_sorted['trade_num'] = list(range(1, len(trades_sorted) + 1))

                # Mapear as colunas do vectorbt para as colunas que nosso código usa
                column_mapping = {
                    'entry': 'entry_price',
                    'exit': 'exit_price',
                    'side': 'direction',
                    'entry_time': None,  # Não temos equivalente direto, será calculado
                    'exit_time': None    # Não temos equivalente direto, será calculado
                }

                # Adicionar informações de data/hora baseadas nos índices, se ausentes
                if 'entry_time' not in trades_sorted.columns and 'entry_idx' in trades_sorted.columns:
                    # Tentar converter os índices para timestamps usando o índice do DataFrame original
                    try:
                        trades_sorted['entry_time'] = trades_sorted['entry_idx'].apply(lambda idx: df.index[int(idx)] if idx < len(df.index) else pd.Timestamp.now())
                    except:
                        # Se falhar, usar um timestamp padrão
                        trades_sorted['entry_time'] = pd.Timestamp.now()

                if 'exit_time' not in trades_sorted.columns and 'exit_idx' in trades_sorted.columns:
                    try:
                        trades_sorted['exit_time'] = trades_sorted['exit_idx'].apply(lambda idx: df.index[int(idx)] if idx < len(df.index) else pd.Timestamp.now())
                    except:
                        trades_sorted['exit_time'] = pd.Timestamp.now()

                for _, trade in trades_sorted.iterrows():
                    # Obter valores corretos usando o mapeamento de colunas
                    entry_price = trade.get(column_mapping.get('entry', 'entry_price'), trade.get('entry', 0))
                    exit_price = trade.get(column_mapping.get('exit', 'exit_price'), trade.get('exit', 0))
                    direction = trade.get(column_mapping.get('side', 'direction'), trade.get('side', 1))

                    # Calcular valores financeiros
                    entry_value = trade['size'] * entry_price

                    # Verificar se as colunas necessárias existem
                    has_pnl = 'pnl' in trade and not pd.isna(trade['pnl'])
                    has_return = 'return' in trade and not pd.isna(trade['return'])

                    # Use valores padrão se não existir
                    pnl_value = trade['pnl'] if has_pnl else 0.0
                    pnl_pct = trade['return'] * 100 if has_return else 0.0

                    # Adicionar lucro ao acumulado
                    running_pnl += pnl_value if has_pnl else 0.0

                    # Linha de ENTRADA
                    entry_row = {
                        'Operação #': trade['trade_num'],
                        'Tipo': f"{'Entrada compra' if direction > 0 else 'Entrada venda'}",
                        'Sinal': 'COMPRA' if direction > 0 else 'VENDA',
                        'Data/Tempo': pd.to_datetime(trade['entry_time']).strftime('%d de %b. de %Y, %H:%M') if 'entry_time' in trade else 'N/A',
                        'Preço': f"{entry_price:.2f}",
                        'Entrada': f"{entry_value:.2f} USDT",
                        'Lucro': '',
                        'Lucro acumulado': '',
                        'Run-up': '',
                        'Drawdown': ''
                    }

                    # Adicionar linha de entrada ao DataFrame
                    trades_expanded.append(entry_row)

                    # Adicionar linha de saída apenas se tiver dados de saída
                    if 'exit_idx' in trade and not pd.isna(trade['exit_idx']):
                        # Calcular Run-up e Drawdown (se disponíveis)
                        run_up = trade.get('run_up', 0)
                        run_up_pct = (run_up / entry_value) * 100 if entry_value > 0 else 0

                        drawdown = trade.get('drawdown', 0)
                        drawdown_pct = (drawdown / entry_value) * 100 if entry_value > 0 else 0

                        # Linha de SAÍDA
                        exit_row = {
                            'Operação #': trade['trade_num'],
                            'Tipo': f"{'Saída compra' if direction > 0 else 'Saída venda'}",
                            'Sinal': f"{'TP/SL Compra' if direction > 0 else 'TP/SL Venda'}",
                            'Data/Tempo': pd.to_datetime(trade['exit_time']).strftime('%d de %b. de %Y, %H:%M') if 'exit_time' in trade else 'N/A',
                            'Preço': f"{exit_price:.2f}",
                            'Entrada': '',
                            'Lucro': f"+{pnl_value:.2f} USDT\n+{pnl_pct:.2f}%" if pnl_value >= 0 else f"{pnl_value:.2f} USDT\n{pnl_pct:.2f}%",
                            'Lucro acumulado': f"+{running_pnl:.2f} USDT" if running_pnl >= 0 else f"{running_pnl:.2f} USDT",
                            'Run-up': f"+{run_up:.2f} USDT\n+{run_up_pct:.2f}%" if run_up > 0 else "0.00 USDT\n0.00%",
                            'Drawdown': f"{drawdown:.2f} USDT\n{drawdown_pct:.2f}%" if drawdown < 0 else "0.00 USDT\n0.00%"
                        }
                        trades_expanded.append(exit_row)

                    trade_num += 1

            # Processar negociações abertas
            if trades_open_has_data:
                # Para negociações abertas, precisamos adaptar conforme o tipo retornado
                open_trades_list = []

                try:
                    # Tentar diferentes abordagens para extrair dados de trades abertos
                    if isinstance(trades_open, pd.DataFrame) and not trades_open.empty:
                        # Se for DataFrame, iterar normalmente
                        for _, trade in trades_open.iterrows():
                            trade_dict = {}
                            # Detectar quais colunas estão disponíveis e mapear para nosso formato
                            if 'entry_price' in trade:
                                trade_dict['entry'] = trade['entry_price']
                            elif 'entry' in trade:
                                trade_dict['entry'] = trade['entry']

                            if 'size' in trade:
                                trade_dict['size'] = trade['size']

                            if 'direction' in trade:
                                trade_dict['side'] = trade['direction']
                            elif 'side' in trade:
                                trade_dict['side'] = trade['side']
                            else:
                                trade_dict['side'] = 1  # padrão para long

                            if 'entry_time' in trade:
                                trade_dict['entry_time'] = trade['entry_time']
                            elif 'entry_idx' in trade:
                                try:
                                    trade_dict['entry_time'] = df.index[int(trade['entry_idx'])]
                                except:
                                    trade_dict['entry_time'] = pd.Timestamp.now()
                            else:
                                trade_dict['entry_time'] = pd.Timestamp.now()

                            open_trades_list.append(trade_dict)
                    elif hasattr(trades_open, '__iter__'):
                        # Iterar objetos que não são DataFrame
                        for trade in trades_open:
                            if hasattr(trade, '_asdict'):
                                # Se for namedtuple
                                trade_dict = trade._asdict()
                            else:
                                # Tentar acessar atributos diretamente
                                trade_dict = {}

                                # Entry price
                                if hasattr(trade, 'entry_price'):
                                    trade_dict['entry'] = trade.entry_price
                                elif hasattr(trade, 'entry'):
                                    trade_dict['entry'] = trade.entry
                                else:
                                    trade_dict['entry'] = df['close'].iloc[-1]

                                # Size
                                if hasattr(trade, 'size'):
                                    trade_dict['size'] = trade.size
                                else:
                                    trade_dict['size'] = 1.0  # valor padrão

                                # Direction/side
                                if hasattr(trade, 'direction'):
                                    trade_dict['side'] = trade.direction
                                elif hasattr(trade, 'side'):
                                    trade_dict['side'] = trade.side
                                else:
                                    trade_dict['side'] = 1

                                # Entry time
                                if hasattr(trade, 'entry_time'):
                                    trade_dict['entry_time'] = trade.entry_time
                                elif hasattr(trade, 'entry_idx') and hasattr(trade.entry_idx, '__int__'):
                                    idx = int(trade.entry_idx)
                                    trade_dict['entry_time'] = df.index[idx] if idx < len(df.index) else pd.Timestamp.now()
                                else:
                                    trade_dict['entry_time'] = pd.Timestamp.now()

                            open_trades_list.append(trade_dict)

                    # Resto do processamento para trades abertos
                    for trade in open_trades_list:
                        # Calcular valor financeiro da entrada
                        entry_value = trade['size'] * trade['entry']

                        # Calcular o PnL não realizado da posição aberta (preço atual vs. preço de entrada)
                        current_price = df['close'].iloc[-1]
                        unrealized_pnl = (current_price - trade['entry']) * trade['size'] if trade['side'] == 1 else (trade['entry'] - current_price) * trade['size']
                        unrealized_pct = (unrealized_pnl / entry_value) * 100 if entry_value > 0 else 0

                        # Linha de ENTRADA
                        entry_row = {
                            'Operação #': trade_num,
                            'Tipo': f"{'Entrada compra' if trade['side'] == 1 else 'Entrada venda'}",
                            'Sinal': 'COMPRA' if trade['side'] == 1 else 'VENDA',
                            'Data/Tempo': pd.to_datetime(trade['entry_time']).strftime('%d de %b. de %Y, %H:%M'),
                            'Preço': f"{trade['entry']:.2f}",
                            'Entrada': f"{entry_value:.2f} USDT",
                            'Lucro': '',
                            'Lucro acumulado': '',
                            'Run-up': '',
                            'Drawdown': ''
                        }

                        # Linha de posição aberta (ao invés de saída)
                        open_row = {
                            'Operação #': trade_num,
                            'Tipo': f"{'Posição aberta (compra)' if trade['side'] == 1 else 'Posição aberta (venda)'}",
                            'Sinal': 'EM ANDAMENTO',
                            'Data/Tempo': pd.to_datetime('now').strftime('%d de %b. de %Y, %H:%M'),
                            'Preço': f"{current_price:.2f} (atual)",
                            'Entrada': '',
                            'Lucro': f"+{unrealized_pnl:.2f} USDT\n+{unrealized_pct:.2f}% (não realizado)" if unrealized_pnl >= 0 else f"{unrealized_pnl:.2f} USDT\n{unrealized_pct:.2f}% (não realizado)",
                            'Lucro acumulado': '',
                            'Run-up': '',
                            'Drawdown': ''
                        }

                        # Adicionar linhas ao DataFrame expandido
                        trades_expanded.append(entry_row)
                        trades_expanded.append(open_row)
                        trade_num += 1
                except Exception as e:
                    st.warning(f"Erro ao processar trades abertos: {str(e)}")
                    st.exception(e)

            # Criar DataFrame final com todas as linhas
            if trades_expanded:
                trades_final = pd.DataFrame(trades_expanded)

                # Função para colorir células com base no conteúdo
                def highlight_trades(val):
                    if isinstance(val, str):
                        if 'Entrada' in val:
                            return 'background-color: #f0f8ff'  # Azul claro para entradas
                        elif 'Saída' in val:
                            return 'background-color: #fff0f5'  # Rosa claro para saídas
                        elif 'Posição aberta' in val:
                            return 'background-color: #fffacd'  # Amarelo claro para posições abertas
                    return ''

                def highlight_pnl(val):
                    if isinstance(val, str) and val:
                        if '+' in val:
                            return 'color: #32CD32; font-weight: bold'  # Verde para lucro
                        elif '-' in val or val[0].isdigit():
                            return 'color: #FF4500; font-weight: bold'  # Vermelho para perda
                    return ''

                # Aplicar estilo ao DataFrame
                styled_trades = trades_final.style.applymap(highlight_trades, subset=['Tipo'])\
                                               .applymap(highlight_pnl, subset=['Lucro', 'Lucro acumulado'])

                # Exibir tabela estilizada
                st.dataframe(styled_trades, use_container_width=True)
            else:
                st.info("Não há dados suficientes para exibir negociações detalhadas.")
        else:
            st.info("Nenhuma negociação concluída no período analisado.")

    except Exception as e:
        st.warning(f"Não foi possível exibir negociações detalhadas: {str(e)}")
        # Para debugging
        st.exception(e)

    st.subheader("Curva de Patrimônio")
    pf_fig = pf.plot()
    st.plotly_chart(pf_fig, use_container_width=True)
except Exception as e:
    st.error(f"Erro ao calcular estatísticas do backtest: {str(e)}")

# ===== Price Chart with Signals =====
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
        name="Venda"
    ))
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

# Após o código existente do gráfico, adicione:
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

# ===== Live Signal Trigger =====
st.header("🔔 Envio de Sinal (Ao Vivo)")
if st.button("Gerar e Enviar Último Sinal"):
    side = None
    entry = df["close"].iloc[-1]
    if entries_long.iloc[-1]:
        side = "buy"
        sl   = sl_long.iloc[-1]
        tp   = tp_long.iloc[-1]
    elif entries_short.iloc[-1]:
        side = "sell"
        sl   = sl_short.iloc[-1]
        tp   = tp_short.iloc[-1]

    if side:
        side_display = "COMPRA" if side == "buy" else "VENDA"
        payload = {
            "symbol": symbol,
            "side": side,
            "entry": float(f"{entry:.2f}"),
            "tp": float(f"{tp:.2f}"),
            "sl": float(f"{sl:.2f}"),
            "leverage": leverage
        }
        res = requests.post(webhook_url, json=payload)
        if res.ok:
            st.success(f"Sinal {side_display} enviado com sucesso!")
        else:
            st.error(f"Falha ao enviar sinal: {res.status_code}")
    else:
        st.info("Nenhum sinal gerado na última vela.")
