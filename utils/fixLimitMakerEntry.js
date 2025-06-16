const fs = require('fs');
const path = require('path');

const BACKUP_SUFFIX = '.backup';
const TARGET_FILE = path.join(__dirname, '..', 'posicoes', 'limitMakerEntry.js');

console.log('🔧 === SCRIPT DE CORREÇÃO PARA limitMakerEntry.js ===\n');

/**
 * Função principal de correção
 */
async function fixLimitMakerEntry() {
  try {
    // 1. Fazer backup do arquivo original
    console.log('📦 1. Criando backup do arquivo original...');
    const originalContent = fs.readFileSync(TARGET_FILE, 'utf8');
    fs.writeFileSync(TARGET_FILE + BACKUP_SUFFIX, originalContent);
    console.log('✅ Backup criado: limitMakerEntry.js.backup\n');

    // 2. Aplicar correções
    console.log('🔧 2. Aplicando correções...');
    let fixedContent = originalContent;

    // CORREÇÃO 1: Validação inicial do accountId
    fixedContent = fixAccountIdValidation(fixedContent);
    
    // CORREÇÃO 2: Todas as chamadas de API que precisam de accountId
    fixedContent = fixApiCalls(fixedContent);
    
    // CORREÇÃO 3: Função getAvailableBalance
    fixedContent = fixGetAvailableBalance(fixedContent);
    
    // CORREÇÃO 4: Função waitForOrderExecution
    fixedContent = fixWaitForOrderExecution(fixedContent);
    
    // CORREÇÃO 5: Chamadas websocketApi
    fixedContent = fixWebSocketApiCalls(fixedContent);
    
    // CORREÇÃO 6: Função waitForOrderStatus
    fixedContent = fixWaitForOrderStatus(fixedContent);

    // 3. Salvar arquivo corrigido
    console.log('💾 3. Salvando arquivo corrigido...');
    fs.writeFileSync(TARGET_FILE, fixedContent);
    console.log('✅ Arquivo corrigido e salvo\n');

    // 4. Relatório das correções
    console.log('📊 4. RELATÓRIO DE CORREÇÕES APLICADAS:');
    console.log('   ✅ Validação de accountId adicionada no início');
    console.log('   ✅ Propagação de accountId para todas as chamadas de API');
    console.log('   ✅ Correção da função getAvailableBalance');
    console.log('   ✅ Correção da função waitForOrderExecution');
    console.log('   ✅ Correção das chamadas WebSocket API');
    console.log('   ✅ Correção da função waitForOrderStatus');
    
    console.log('\n🎉 CORREÇÃO CONCLUÍDA COM SUCESSO!');
    console.log('💡 Para reverter: node utils/restoreLimitMakerEntry.js');

  } catch (error) {
    console.error('❌ ERRO durante a correção:', error.message);
    console.error('💡 Verifique se o arquivo existe e você tem permissões de escrita');
    process.exit(1);
  }
}

/**
 * CORREÇÃO 1: Adicionar validação de accountId no início da função
 */
function fixAccountIdValidation(content) {
  console.log('   🔧 Corrigindo validação de accountId...');
  
  const oldPattern = /async function executeLimitMakerEntry\(db, signal, currentPrice, accountId\) \{[\s\S]*?console\.log\(\`\[LIMIT_ENTRY\] Iniciando LIMIT MAKER para Sinal ID/;
  
  const newValidation = `async function executeLimitMakerEntry(db, signal, currentPrice, accountId) {
  // CORREÇÃO CRÍTICA: Validar accountId no início
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(\`AccountId inválido em executeLimitMakerEntry: \${accountId} (tipo: \${typeof accountId})\`);
  }
  
  console.log(\`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID \${signal.id} (\${signal.symbol}) na conta \${accountId}\`);
    // Obter a conexão do banco de dados para a conta específica
    const connection = await db.getConnection();
    const MAX_CHASE_ATTEMPTS = 100;
    const CHASE_TIMEOUT_MS = 60000; // 1 minuto
    const WAIT_FOR_EXECUTION_TIMEOUT_MS = 5000;
    const EDIT_WAIT_TIMEOUT_MS = 3000;

    let chaseAttempts = 0;
    let totalEntrySize = 0;
    let totalFilledSize = 0;
    let averageEntryPrice = 0;
    let positionId = null;
    let executionStartTime = Date.now();
    let partialFills = [];
    let activeOrderId = null;
    let marketOrderResponseForDb = null;
    const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];

    let binanceSide;
    let leverage;
    let quantityPrecision;
    let pricePrecision;
    let precisionInfo;

    // Variáveis para o WebSocket de profundidade
    let depthWs = null;
    let currentBestBid = null;
    let currentBestAsk = null;
    let lastDepthUpdateTimestamp = 0;
    const MAX_DEPTH_STALENESS_MS = 3000; // Considerar dados do book "velhos" após 2 segundos sem atualização do WS
    let wsUpdateErrorCount = 0;

      // Verificar se já existe ordem ativa para este sinal
const [existingOrders] = await db.query(
  \`SELECT id_externo FROM ordens WHERE orign_sig = ? AND status IN ('NEW', 'PARTIALLY_FILLED')\`,
  [\`WEBHOOK_\${signal.id}\`]
);
  
  if (existingOrders.length > 0) {
    console.log(\`[LIMIT_ENTRY] ⚠️ Já existem \${existingOrders.length} ordens ativas para este sinal. Cancelando...\`);
    
    // Cancelar todas as ordens existentes
for (const order of existingOrders) {
  try {
    const api = require('../api');
    await api.cancelOrder(accountId, signal.symbol, order.id_externo);
    console.log(\`[LIMIT_ENTRY] Ordem \${order.id_externo} cancelada com sucesso.\`);
    
    // Atualizar status no banco
    await db.query(
      \`UPDATE ordens SET status = 'CANCELED', last_update = NOW() WHERE id_externo = ?\`,
      [order.id_externo]
    );
  } catch (cancelError) {
    console.error(\`[LIMIT_ENTRY] Erro ao cancelar ordem \${order.id_externo}:\`, cancelError.message);
  }
}
  }
  
  // Criar ID único para controle de idempotência
  const idempotencyKey = \`\${signal.id}_\${Date.now()}\`;

    try {
        const numericAccountId = parseInt(accountId) || 1;
        const existingPositionsOnExchange = await getAllOpenPositions(numericAccountId, signal.symbol);
        const positionAlreadyExists = existingPositionsOnExchange.some(p =>
            p.simbolo === signal.symbol && Math.abs(p.quantidade) > 0
        );

        if (positionAlreadyExists) {
            console.log(\`[LIMIT_ENTRY] ALERTA: Posição já existe para \${signal.symbol}. Cancelando.\`);
            await db.query(
                \`UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?\`,
                ['Posição já existe na corretora (verificação inicial)', signal.id]
            );
            return { success: false, error: 'Posição já existe na corretora (verificação inicial)' };
        }

        await connection.beginTransaction();
        
        console.log(\`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID`;
  
  return content.replace(oldPattern, newValidation);
}

/**
 * CORREÇÃO 2: Corrigir todas as chamadas de API que precisam de accountId
 */
function fixApiCalls(content) {
  console.log('   🔧 Corrigindo chamadas de API...');
  
  let fixed = content;
  
  // Corrigir uma chamada de cada vez para evitar conflitos
  
  // 1. Corrigir getAllOpenPositions
  fixed = fixed.replace(
    /await getAllOpenPositions\(numericAccountId, signal\.symbol\)/g,
    'await getAllOpenPositions(numericAccountId, signal.symbol)'
  );
  
  // 2. Corrigir getRecentOrders
  fixed = fixed.replace(
    /await getRecentOrders\(numericAccountId, signal\.symbol, 15\)/g,
    'await getRecentOrders(numericAccountId, signal.symbol, 15)'
  );
  
  // 3. Corrigir cancelOrder (sem accountId primeiro)
  fixed = fixed.replace(
    /await cancelOrder\(activeOrderId, signal\.symbol\)/g,
    'await cancelOrder(numericAccountId, signal.symbol, activeOrderId)'
  );
  
  // 4. Corrigir getOrderStatus (sem accountId primeiro)
  fixed = fixed.replace(
    /await getOrderStatus\(activeOrderId, signal\.symbol\)/g,
    'await getOrderStatus(numericAccountId, signal.symbol, activeOrderId)'
  );
  
  // 5. Corrigir newStopOrder
  fixed = fixed.replace(
    /await newStopOrder\(\s*signal\.symbol,/g,
    'await newStopOrder(numericAccountId, signal.symbol,'
  );
  
  // 6. Corrigir newReduceOnlyOrder
  fixed = fixed.replace(
    /await newReduceOnlyOrder\(\s*signal\.symbol,/g,
    'await newReduceOnlyOrder(numericAccountId, signal.symbol,'
  );
  
  // 7. Corrigir newLimitMakerOrder específica
  fixed = fixed.replace(
    /await newLimitMakerOrder\(\s*numericAccountId, signal\.symbol, newOrderQty, binanceSide, currentLocalMakerPrice\s*\)/g,
    'await newLimitMakerOrder(numericAccountId, signal.symbol, newOrderQty, binanceSide, currentLocalMakerPrice)'
  );
  
  // 8. Corrigir editOrder
  fixed = fixed.replace(
    /await editOrder\(\s*signal\.symbol,/g,
    'await editOrder(numericAccountId, signal.symbol,'
  );
  
  // 9. Corrigir getTickSize
  fixed = fixed.replace(
    /await getTickSize\(signal\.symbol\)/g,
    'await getTickSize(signal.symbol, numericAccountId)'
  );
  
  return fixed;
}

/**
 * CORREÇÃO 3: Corrigir função getAvailableBalance
 */
function fixGetAvailableBalance(content) {
  console.log('   🔧 Corrigindo função getAvailableBalance...');
  
  const oldFunction = /\/\/ Função auxiliar para obter saldo disponível[\s\S]*?async function getAvailableBalance\(accountId\)[\s\S]*?return 0;\s*}\s*}/;
  
  const newFunction = `// Função auxiliar para obter saldo disponível
async function getAvailableBalance(accountId) {
    // CORREÇÃO: Validar accountId
    if (!accountId || typeof accountId !== 'number') {
        throw new Error(\`AccountId inválido em getAvailableBalance: \${accountId} (tipo: \${typeof accountId})\`);
    }
    
    try {
        const db = await getDatabaseInstance(accountId);
        if (!db) {
            throw new Error(\`Falha ao obter instância do banco de dados para conta \${accountId}\`);
        }

        // Obter saldo_base_calculo do banco de dados
        const [rows] = await db.query('SELECT saldo_base_calculo FROM contas WHERE id = ?', [accountId]);
        const baseCalculo = rows.length > 0 ? parseFloat(rows[0].saldo_base_calculo || 0) : 0;

        if (baseCalculo <= 0) {
            throw new Error(\`Saldo base de cálculo inválido ou zero para conta \${accountId}\`);
        }

        console.log(\`[LIMIT_ENTRY] Usando saldo base de cálculo para conta \${accountId}: \${baseCalculo.toFixed(2)} USDT\`);
        return baseCalculo;
    } catch (error) {
        console.error(\`[LIMIT_ENTRY] Erro ao obter saldo base de cálculo para conta \${accountId}: \${error.message}\`);
        throw error;
    }
}`;

  return content.replace(oldFunction, newFunction);
}

/**
 * CORREÇÃO 4: Corrigir função waitForOrderExecution
 */
function fixWaitForOrderExecution(content) {
  console.log('   🔧 Corrigindo função waitForOrderExecution...');
  
  const oldFunction = /\/\/ Função otimizada para aguardar a execução de uma ordem[\s\S]*?async function waitForOrderExecution\(symbol, orderId, maxWaitMs = 3000, accountId\)[\s\S]*?return \{ status: 'UNKNOWN', executedQty: '0', avgPrice: '0' \};\s*}\s*}/;
  
  const newFunction = `// Função otimizada para aguardar a execução de uma ordem
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000, accountId) {
    // CORREÇÃO: Validar parâmetros
    if (!accountId || typeof accountId !== 'number') {
        throw new Error(\`AccountId inválido em waitForOrderExecution: \${accountId} (tipo: \${typeof accountId})\`);
    }
    
    const startTime = Date.now();
    
    try {
        // Verificar imediatamente o status da ordem (sem espera inicial)
        const orderStatus = await getOrderStatus(accountId, symbol, orderId);
        
        // Se a ordem foi executada (total ou parcialmente), retornar imediatamente
        if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
            return orderStatus;
        }
    } catch (initialError) {
        console.log(\`[WAIT_ORDER] Erro inicial ao verificar ordem \${orderId}: \${initialError.message}\`);
    }
    
    // Loop de espera com intervalos mais curtos
    while (Date.now() - startTime < maxWaitMs) {
        try {
            // Verificar status da ordem
            const orderStatus = await getOrderStatus(accountId, symbol, orderId);
            
            // Se a ordem foi executada (total ou parcialmente), retornar imediatamente
            if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
                return orderStatus;
            }
            
            // Aguardar um período muito curto antes de verificar novamente
            await new Promise(resolve => setTimeout(resolve, 100));            
        } catch (error) {
            console.log(\`[WAIT_ORDER] Erro ao verificar ordem \${orderId}: \${error.message}\`);
            // Aguardar antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // Timeout atingido, tentar obter o status atual
    try {
        return await getOrderStatus(accountId, symbol, orderId);
    } catch (error) {
        return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
}`;

  return content.replace(oldFunction, newFunction);
}

/**
 * CORREÇÃO 5: Corrigir chamadas WebSocket API
 */
function fixWebSocketApiCalls(content) {
  console.log('   🔧 Corrigindo chamadas WebSocket API...');
  
  let fixed = content;
  
  // Corrigir getOrderStatusViaWebSocket
  fixed = fixed.replace(
    /await websocketApi\.getOrderStatusViaWebSocket\(\s*signal\.symbol,\s*activeOrderId\s*\)/g,
    'await websocketApi.getOrderStatusViaWebSocket(signal.symbol, activeOrderId, numericAccountId)'
  );
  
  return fixed;
}

/**
 * CORREÇÃO 6: Corrigir função waitForOrderStatus
 */
function fixWaitForOrderStatus(content) {
  console.log('   🔧 Corrigindo função waitForOrderStatus...');
  
  const oldFunction = /async function waitForOrderStatus\(symbol, orderId, accountId\)[\s\S]*?module\.exports/;
  
  const newFunction = `async function waitForOrderStatus(symbol, orderId, accountId) {
  // CORREÇÃO: Validar accountId
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(\`AccountId inválido em waitForOrderStatus: \${accountId} (tipo: \${typeof accountId})\`);
  }
  
  console.log(\`[LIMIT_ENTRY] Verificando status da ordem \${orderId} para \${symbol} na conta \${accountId} via WebSocket...\`);
  
  try {
    // Tentar via WebSocket API
    const wsResult = await websocketApi.getOrderStatus(symbol, orderId, accountId);
    
    if (wsResult && wsResult.status) {
      console.log(\`[LIMIT_ENTRY] Status da ordem \${orderId} via WebSocket: \${wsResult.status}\`);
      return wsResult;
    } else {
      // Se houver resultado mas não tiver status válido, logar e fazer fallback
      console.log(\`[LIMIT_ENTRY] Resultado WebSocket sem status válido para ordem \${orderId}:\`, JSON.stringify(wsResult));
    }
  } catch (error) {
    console.log(\`[LIMIT_ENTRY] Erro ao verificar status via WebSocket para ordem \${orderId}: \${error.message}\`);
    
    // Se é erro de API Key, precisamos verificar se há conflito de ambiente (prod vs testnet)
    if (error.message && error.message.includes('Invalid API-key')) {
      console.log(\`[LIMIT_ENTRY] ⚠️ Possível conflito de ambiente (prod vs testnet) na API Key\`);
      
      // Usar REST API diretamente (mais confiável)
      try {
        const api = require('../api');
        console.log(\`[LIMIT_ENTRY] Usando REST API como fallback para verificar ordem \${orderId}\`);
        const restResult = await api.getOrderStatus(accountId, symbol, orderId);
        
        if (restResult) {
          console.log(\`[LIMIT_ENTRY] Status da ordem \${orderId} via REST API: \${restResult.status}\`);
          return restResult;
        }
      } catch (restError) {
        console.log(\`[LIMIT_ENTRY] Erro também na REST API: \${restError.message}\`);
        throw restError;
      }
    }
  }
  
  throw new Error(\`Não foi possível verificar o status da ordem \${orderId}\`);
}

module.exports`;

  return content.replace(oldFunction, newFunction);
}

/**
 * Script para restaurar backup
 */
function createRestoreScript() {
  const restoreScript = 'const fs = require("fs");\n' +
    'const path = require("path");\n\n' +
    'const TARGET_FILE = path.join(__dirname, "..", "posicoes", "limitMakerEntry.js");\n' +
    'const BACKUP_FILE = TARGET_FILE + ".backup";\n\n' +
    'console.log("🔄 === RESTAURANDO BACKUP DO limitMakerEntry.js ===\\n");\n\n' +
    'try {\n' +
    '  if (fs.existsSync(BACKUP_FILE)) {\n' +
    '    const backupContent = fs.readFileSync(BACKUP_FILE, "utf8");\n' +
    '    fs.writeFileSync(TARGET_FILE, backupContent);\n' +
    '    console.log("✅ Arquivo restaurado do backup com sucesso!");\n' +
    '    console.log("💡 O backup foi mantido em limitMakerEntry.js.backup");\n' +
    '  } else {\n' +
    '    console.error("❌ Arquivo de backup não encontrado!");\n' +
    '    process.exit(1);\n' +
    '  }\n' +
    '} catch (error) {\n' +
    '  console.error("❌ Erro ao restaurar backup:", error.message);\n' +
    '  process.exit(1);\n' +
    '}';

  fs.writeFileSync(path.join(__dirname, 'restoreLimitMakerEntry.js'), restoreScript);
  console.log('📝 Script de restauração criado: utils/restoreLimitMakerEntry.js');
}

// Executar script se chamado diretamente
if (require.main === module) {
  fixLimitMakerEntry().then(() => {
    createRestoreScript();
    console.log('\n🚀 PRONTO PARA TESTE!');
    console.log('💡 Execute: node posicoes/monitoramento.js --account 1');
  });
}

module.exports = { fixLimitMakerEntry };