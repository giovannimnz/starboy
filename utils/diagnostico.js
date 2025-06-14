const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs = require('fs').promises;
const { getDatabaseInstance } = require('../db/conexao');
const readline = require('readline');

// Declarar variáveis globalmente para uso em todas as funções
let websockets;
let websocketApi;
let axios;
let api;
let latestPrices = new Map(); 

// Função para verificar integridade das exportações antes de importar os módulos
async function verificarExportacoes(filePath) {
  try {
    const conteudo = await fs.readFile(filePath, 'utf8');
    
    // Encontrar objeto de exportação
    const matchExport = conteudo.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
    if (!matchExport) {
      return false;
    }
    
    // Extrair os nomes das funções exportadas
    const exportContent = matchExport[1];
    const exportedFunctions = exportContent
      .split(',')
      .map(item => item.trim())
      .filter(item => item && !item.startsWith('//'))
      .map(item => item.split('//')[0].trim());
    
    // Verificar se cada função está declarada
    for (const funcName of exportedFunctions) {
      if (!funcName) continue;
      
      const functionPattern = new RegExp(`(async\\s+)?function\\s+${funcName}\\s*\\(`);
      const arrowPattern = new RegExp(`(const|let|var)\\s+${funcName}\\s*=\\s*(async\\s*)?\\(`);
      
      if (!functionPattern.test(conteudo) && !arrowPattern.test(conteudo)) {
        console.log(`❌ Função exportada não encontrada: ${funcName} em ${filePath}`);
        // Corrigir automaticamente removendo a exportação
        const fixedContent = conteudo.replace(
          new RegExp(`(,\\s*|\\{\\s*)${funcName}(\\s*,|\\s*\\})`, 'g'),
          (match) => {
            if (match.includes('{')) return match.replace(funcName, '');
            if (match.includes('}')) return match.replace(`,\\s*${funcName}`, '');
            return ',';
          }
        );
        
        // Salvar arquivo corrigido
        await fs.writeFile(filePath, fixedContent, 'utf8');
        console.log(`✅ Exportação problemática removida de ${filePath}`);
        return true; // Indica que correções foram feitas
      }
    }
    
    return false; // Não foram encontrados problemas
  } catch (error) {
    console.error(`Erro ao verificar exportações em ${filePath}:`, error);
    return false;
  }
}

// Função para verificar URLs da corretora
async function verificarURLsCorretora(accountId = 1) {
  try {
    const db = await getDatabaseInstance();
    
    // Obter conexão com conta
    const [conta] = await db.query(
      `SELECT c.id, c.id_corretora, cor.futures_rest_api_url, cor.futures_ws_api_url, cor.futures_ws_market_url
       FROM contas c
       JOIN corretoras cor ON c.id_corretora = cor.id
       WHERE c.id = ? AND c.ativa = 1`,
      [accountId]
    );
    
    if (!conta || conta.length === 0) {
      throw new Error(`Conta ID ${accountId} não encontrada ou não está ativa`);
    }
    
    const contaData = conta[0];
    console.log(`[DIAGNÓSTICO] Conta ID ${accountId} está usando:`);
    console.log(`  - futures_rest_api_url: ${contaData.futures_rest_api_url}`);
    console.log(`  - futures_ws_api_url: ${contaData.futures_ws_api_url}`);
    console.log(`  - futures_ws_market_url: ${contaData.futures_ws_market_url}`);
    
    // Verificar se contém "testnet" onde não deveria
    const isProduction = !contaData.futures_rest_api_url.includes('testnet');
    if (isProduction && contaData.futures_ws_api_url.includes('testnet')) {
      console.log(`[DIAGNÓSTICO] ⚠️ ALERTA: Ambiente de Produção usando WebSocket API do testnet!`);
      
      // Corrigir automaticamente
      await db.query(
        `UPDATE corretoras 
         SET futures_ws_api_url = 'wss://ws-fapi.binance.com/ws-fapi'
         WHERE id = ?`,
        [contaData.id_corretora]
      );
      console.log(`[DIAGNÓSTICO] ✅ URL WebSocket API corrigida para produção`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`[DIAGNÓSTICO] Erro ao verificar URLs da corretora:`, error);
    return false;
  }
}

// Carregar os módulos necessários
async function carregarModulos() {
  try {
    // Importar os módulos só depois da verificação de integridade
    websockets = require('../websockets');
    websocketApi = require('../websocketApi');
    axios = require('axios');
    api = require('../api');
    
    return true;
  } catch (error) {
    console.error('Erro ao carregar módulos:', error);
    return false;
  }
}

// Função principal de diagnóstico
async function diagnosticarECorrigirSinaisPendentes() {
  console.log('=== VERIFICANDO INTEGRIDADE DOS MÓDULOS ===');
  
  // Verificar e corrigir problemas nos principais arquivos
  const arquivosParaVerificar = [
    path.join(__dirname, '../api.js'),
    path.join(__dirname, '../websocketApi.js'),
    path.join(__dirname, '../websockets.js'),
    path.join(__dirname, '../posicoes/limitMakerEntry.js')
  ];
  
  let correcoesFeitasFlag = false;
  
  for (const arquivo of arquivosParaVerificar) {
    console.log(`Verificando ${path.basename(arquivo)}...`);
    const correcoes = await verificarExportacoes(arquivo);
    if (correcoes) correcoesFeitasFlag = true;
  }
  
  if (correcoesFeitasFlag) {
    console.log('\n⚠️ Foram feitas correções automáticas nos arquivos. Por favor, execute o script novamente.');
    process.exit(0);
  }
  
  console.log('=== VERIFICANDO CONFIGURAÇÕES DE URLs ===');
  const urlsCorrigidas = await verificarURLsCorretora(1);
  
  if (urlsCorrigidas) {
    console.log('\n⚠️ URLs da corretora foram corrigidas. Por favor, reinicie o sistema e execute o script novamente.');
    process.exit(0);
  }
  
  console.log('=== DIAGNÓSTICO DE SINAIS PENDENTES ===');
  
  try {
    // Carregar os módulos necessários ANTES de usá-los
    if (!await carregarModulos()) {
      throw new Error('Falha ao carregar módulos necessários');
    }
    
    // Inicializar o WebSocket API para garantir que está pronto
    console.log('[DIAGNÓSTICO] Inicializando WebSocket API (pode levar alguns segundos)...');
    await websocketApi.initializeHandlers(1);
    console.log('[DIAGNÓSTICO] WebSocket API inicializado com sucesso!');
    
    // Obter conexão com o banco
    const db = await getDatabaseInstance();
    console.log('✅ Conexão com o banco de dados estabelecida');
    
    // Verificar sinais pendentes
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
    `);
    
    console.log(`[DIAGNÓSTICO] Encontrados ${pendingSignals.length} sinais pendentes.`);
    
    if (pendingSignals.length === 0) {
      console.log('Não há sinais pendentes para processar.');
      return;
    }
    
    // Verificar se há ordens abertas para os símbolos pendentes
    const symbols = pendingSignals.map(sig => sig.symbol);
    const uniqueSymbols = [...new Set(symbols)];
    
    console.log('[DIAGNÓSTICO] Verificando se já existem ordens abertas...');
    
    // Verificar cada símbolo
    for (const symbol of uniqueSymbols) {
      try {
        const openOrders = await api.getOpenOrders(1, symbol);
        if (openOrders && openOrders.length > 0) {
          console.log(`[DIAGNÓSTICO] ⚠️ Encontradas ${openOrders.length} ordens abertas para ${symbol}:`);
          for (const ordem of openOrders) {
            console.log(`  - OrderID: ${ordem.orderId}, Side: ${ordem.side}, Tipo: ${ordem.type}, Price: ${ordem.price}, Quantidade: ${ordem.origQty}`);
            
            // Cancelar ordens abertas relacionadas
            console.log(`[DIAGNÓSTICO] Cancelando ordem ${ordem.orderId} para ${symbol}...`);
            await api.cancelOrder(1, symbol, ordem.orderId);
            console.log(`[DIAGNÓSTICO] Ordem cancelada com sucesso.`);
          }
        } else {
          console.log(`[DIAGNÓSTICO] Não há ordens abertas para ${symbol}`);
        }
      } catch (error) {
        console.error(`[DIAGNÓSTICO] Erro ao verificar ordens abertas para ${symbol}:`, error.message);
      }
    }
    
    // Mostrar detalhes dos sinais
    pendingSignals.forEach(signal => {
      console.log(`[DIAGNÓSTICO] Sinal ID: ${signal.id}, Symbol: ${signal.symbol}, Status: ${signal.status}`);
      console.log(`  - Side: ${signal.side}, Entry price: ${signal.entry_price}`);
      console.log(`  - Created at: ${new Date(signal.created_at).toLocaleString()}, Account ID: ${signal.conta_id || 1}`);
    });
    
    // Perguntar se deseja processar os sinais
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('\nDeseja processar estes sinais pendentes? (s/n): ', async (answer) => {
      if (answer.toLowerCase() === 's') {
        console.log('\n[CORREÇÃO] Processando sinais pendentes...');
        
        try {
          // Importe diretamente a função que faz todo o processamento
          const monitoramento = require('../posicoes/monitoramento');
          console.log('[CORREÇÃO] Usando função direta do módulo de monitoramento para processar sinais pendentes...');
          await monitoramento.forceProcessPendingSignals(1);
          
          // Verificar status após processamento
          const [updatedSignals] = await db.query(`
            SELECT id, symbol, status, error_message FROM webhook_signals
            WHERE id IN (${pendingSignals.map(s => s.id).join(',')})
          `);
          
          console.log('\n=== RESULTADO FINAL ===');
          updatedSignals.forEach(signal => {
            console.log(`Sinal ID ${signal.id} (${signal.symbol}): Status = ${signal.status}`);
            if (signal.error_message) {
              console.log(`  - Erro: ${signal.error_message}`);
            }
          });
        } catch (error) {
          console.error('[CORREÇÃO] Erro ao processar sinais:', error);
        }
      } else {
        console.log('Operação cancelada pelo usuário.');
      }
      
      rl.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Erro no diagnóstico:', error);
    process.exit(1);
  }
}

// Executar diagnóstico
diagnosticarECorrigirSinaisPendentes().catch(console.error);