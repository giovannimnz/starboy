const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs = require('fs').promises;
const { getDatabaseInstance } = require('../db/conexao');
const readline = require('readline');

// Declarar variáveis globalmente para uso em todas as funções
let websockets;
let websocketApi;
let axios;
let latestPrices = new Map(); // Esta variável faltava e é usada em getWebSocketPrice

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

// Carregar os módulos necessários
async function carregarModulos() {
  try {
    // Importar os módulos só depois da verificação de integridade
    websockets = require('../websockets');
    websocketApi = require('../websocketApi');
    axios = require('axios');
    
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
  
  console.log('=== DIAGNÓSTICO DE SINAIS PENDENTES ===');
  
  try {
    // Carregar os módulos necessários ANTES de usá-los
    if (!await carregarModulos()) {
      throw new Error('Falha ao carregar módulos necessários');
    }
    
    const { executeLimitMakerEntry } = require('../posicoes/limitMakerEntry');
    
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
        
        for (const signal of pendingSignals) {
          console.log(`\n[CORREÇÃO] Processando sinal ID ${signal.id} (${signal.symbol})...`);
          
          try {
            // Marcar como em processamento
            await db.query(
              'UPDATE webhook_signals SET status = "PROCESSANDO" WHERE id = ?',
              [signal.id]
            );
            
            // Obter preço atual
            console.log(`[CORREÇÃO] Obtendo preço atual para ${signal.symbol}...`);
            const currentPrice = await getCurrentPrice(signal.symbol);
            
            if (!currentPrice) {
              throw new Error(`Não foi possível obter preço atual para ${signal.symbol}`);
            }
            
            console.log(`[CORREÇÃO] Preço atual de ${signal.symbol}: ${currentPrice}`);
            
            // Executar a entrada
            console.log(`[CORREÇÃO] Executando entrada para ${signal.symbol}...`);
            
            const entryResult = await executeLimitMakerEntry(db, signal, currentPrice, signal.conta_id || 1);
            
            if (entryResult && entryResult.success) {
              console.log(`[CORREÇÃO] ✅ Entrada executada com sucesso para sinal ID ${signal.id}`);
              console.log(`  - Position ID: ${entryResult.positionId}`);
              console.log(`  - Quantidade: ${entryResult.filledQuantity}`);
              console.log(`  - Preço médio: ${entryResult.averagePrice}`);
            } else {
              console.log(`[CORREÇÃO] ❌ Falha ao executar entrada: ${entryResult?.error || 'Erro desconhecido'}`);
            }
          } catch (error) {
            console.error(`[CORREÇÃO] ❌ Erro ao processar sinal ID ${signal.id}:`, error);
            
            // Atualizar status para ERROR
            try {
              await db.query(
                'UPDATE webhook_signals SET status = "ERROR", error_message = ? WHERE id = ?',
                [error.message.substring(0, 250), signal.id]
              );
              console.log(`[CORREÇÃO] Status do sinal atualizado para ERROR`);
            } catch (updateError) {
              console.error(`[CORREÇÃO] Erro adicional ao atualizar status:`, updateError);
            }
          }
        }
        
        console.log('\n[CORREÇÃO] Processamento de sinais concluído.');
      } else {
        console.log('Operação cancelada pelo usuário.');
      }
      
      rl.close();
      
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
      
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Erro no diagnóstico:', error);
    process.exit(1);
  }
}

// Função para obter preço via WebSocket
async function getCurrentPrice(symbol) {
  try {
    console.log(`[DIAGNÓSTICO] Tentando obter preço de ${symbol} via WebSocket API...`);
    
    // Garantir que a WebSocket API está inicializada
    await websocketApi.initializeHandlers(1); // accountId = 1
    
    // Iniciar o WebSocket de preço se necessário
    try {
      await websockets.ensurePriceWebsocketExists(symbol, 1);
      
      // Aguardar um momento para o WebSocket receber dados
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Tentar obter o preço do cache de WebSocket
      const price = await getWebSocketPrice(symbol);
      
      if (price && !isNaN(price) && price > 0) {
        console.log(`[DIAGNÓSTICO] Preço obtido via WebSocket: ${price}`);
        return price;
      }
    } catch (wsError) {
      console.log(`[DIAGNÓSTICO] Erro ao usar WebSocket: ${wsError.message}`);
    }
    
    // Fallback para API REST
    console.log('[DIAGNÓSTICO] Usando fallback REST API para obter preço');
    
    // Obter URL da API da corretora
    const api = require('../api');
    const credentials = await api.loadCredentialsFromDatabase(1);
    
    // Construir URL completa garantindo que é válida
    const completeUrl = `${credentials.apiUrl}/v1/ticker/price?symbol=${symbol}`;
    console.log(`[DIAGNÓSTICO] URL de consulta de preço: ${completeUrl}`);
    
    // Fazer requisição HTTP
    const response = await axios.get(completeUrl);
    
    if (response.data && response.data.price) {
      const price = parseFloat(response.data.price);
      console.log(`[DIAGNÓSTICO] Preço obtido via REST API: ${price}`);
      return price;
    }
    throw new Error('Preço não disponível na resposta da REST API');
  } catch (error) {
    console.log(`[DIAGNÓSTICO] Erro ao obter preço: ${error.message}`);
    throw error;
  }
}

/**
 * Função para obter o preço atual usando o cache de websocket
 * @param {string} symbol - Símbolo do par
 * @param {number} maxAgeMs - Idade máxima do preço em cache (ms)
 * @returns {Promise<number>} O preço atual
 */
async function getWebSocketPrice(symbol, maxAgeMs = 5000) {
  // Se não temos o símbolo no cache ou não tem websocket iniciado, iniciamos um
  if (!latestPrices.has(symbol)) {
    console.log(`[MONITOR] Iniciando monitoramento de preço via WebSocket para ${symbol}`);
    await websockets.ensurePriceWebsocketExists(symbol);
    
    // Aguardar um tempo para o websocket receber a primeira atualização
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Verificar se temos uma atualização recente no cache
  const priceEntry = latestPrices.get(symbol);
  const now = Date.now();
  
  if (priceEntry && (now - priceEntry.timestamp) < maxAgeMs) {
    return priceEntry.price;
  }

  // Se o preço for muito antigo ou não existir, fazer fallback para REST API
  console.log(`[MONITOR] Preço de ${symbol} não disponível via WebSocket (ou antigo), usando REST API como fallback`);
  try {
    // Obter URL da API da corretora
    const api = require('../api');
    const credentials = await api.loadCredentialsFromDatabase(1);
    
    // Construir URL completa garantindo que é válida
    const completeUrl = `${credentials.apiUrl}/v1/ticker/price?symbol=${symbol}`;
    const response = await axios.get(completeUrl);
    
    if (!response.data || !response.data.price) {
      throw new Error(`Resposta inválida da API para ${symbol}`);
    }
    
    const restPrice = parseFloat(response.data.price);
    
    // Atualizar o cache com o preço da REST API
    if (restPrice) {
      latestPrices.set(symbol, {
        price: restPrice,
        timestamp: Date.now(),
        bid: restPrice * 0.9999,
        ask: restPrice * 1.0001
      });
    }
    
    return restPrice;
  } catch (error) {
    console.error(`[MONITOR] Erro no fallback REST para ${symbol}:`, error);
    
    // Se temos algum preço em cache, mesmo antigo, retorná-lo como último recurso
    if (priceEntry) {
      console.log(`[MONITOR] Usando preço em cache antigo para ${symbol}: ${priceEntry.price}`);
      return priceEntry.price;
    }
    
    throw error;
  }
}

// Executar diagnóstico
diagnosticarECorrigirSinaisPendentes();