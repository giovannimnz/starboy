#!/usr/bin/env node

/**
 * 🧪 TESTE: Sistema de Detecção e Correção de Posições Órfãs
 * 
 * Este script testa a funcionalidade de fallback que detecta posições na corretora
 * que não foram criadas pelo webhook e cria automaticamente as ordens SL, RPs e TP
 * baseadas no último sinal para o símbolo.
 * 
 * CRITÉRIOS PARA POSIÇÃO ÓRFÃ:
 * 1. Posição existe na corretora há mais de 4 minutos
 * 2. Não tem ordens abertas na corretora  
 * 3. Não tem ordens de proteção (SL/TP) no banco OU não existe no banco
 * 4. Existe um sinal com preços de SL/TP para o símbolo
 * 
 * USO:
 * node test-orphan-positions.js [accountId]
 * 
 * EXEMPLOS:
 * node test-orphan-positions.js 1        # Testar conta 1
 * node test-orphan-positions.js          # Testar conta padrão (1)
 */

const { detectAndFixOrphanPositions, createMissingOrdersForPosition } = require('./positionSync');
const { getAllOpenPositions } = require('../api/rest');
const { getDatabaseInstance } = require('../../../core/database/conexao');

// ✅ CONFIGURAÇÃO
const DEFAULT_ACCOUNT_ID = 1;
const TEST_MODE = process.env.NODE_ENV === 'test' || process.argv.includes('--dry-run');

/**
 * ✅ FUNÇÃO PRINCIPAL DE TESTE
 */
async function testOrphanPositionDetection() {
  console.log('🧪 TESTE: Sistema de Detecção de Posições Órfãs');
  console.log('=' .repeat(60));
  
  try {
    // ✅ OBTER ACCOUNT_ID
    const accountId = parseInt(process.argv[2]) || DEFAULT_ACCOUNT_ID;
    console.log(`📊 Testando conta: ${accountId}`);
    
    if (TEST_MODE) {
      console.log('🚨 MODO TESTE: Apenas análise, sem criar ordens reais');
    }
    
    // ✅ VERIFICAR CONEXÃO COM BANCO
    console.log('\n🔍 1. Verificando conexão com banco...');
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error('Falha ao conectar com banco de dados');
    }
    console.log('✅ Conexão com banco estabelecida');
    
    // ✅ OBTER POSIÇÕES DA CORRETORA
    console.log('\n🔍 2. Obtendo posições da corretora...');
    const exchangePositions = await getAllOpenPositions(accountId);
    console.log(`📊 Encontradas ${exchangePositions.length} posições na corretora`);
    
    if (exchangePositions.length === 0) {
      console.log('ℹ️ Nenhuma posição encontrada na corretora. Teste finalizado.');
      return;
    }
    
    // ✅ LISTAR POSIÇÕES ENCONTRADAS
    console.log('\n📋 Posições na corretora:');
    exchangePositions.forEach((pos, index) => {
      const ageMinutes = pos.tempoAbertura ? Math.floor((Date.now() - pos.tempoAbertura) / (1000 * 60)) : 'N/A';
      console.log(`  ${index + 1}. ${pos.simbolo}: ${pos.quantidade} (idade: ${ageMinutes} min)`);
    });
    
    // ✅ VERIFICAR POSIÇÕES NO BANCO
    console.log('\n🔍 3. Verificando posições no banco...');
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, status, data_hora_abertura
      FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = $1
      ORDER BY simbolo
    `, [accountId]);
    
    console.log(`📊 Encontradas ${dbPositions.length} posições no banco`);
    
    if (dbPositions.length > 0) {
      console.log('\n📋 Posições no banco:');
      dbPositions.forEach((pos, index) => {
        const ageMinutes = Math.floor((Date.now() - new Date(pos.data_hora_abertura).getTime()) / (1000 * 60));
        console.log(`  ${index + 1}. ${pos.simbolo} (ID: ${pos.id}): ${pos.quantidade} (idade: ${ageMinutes} min)`);
      });
    }
    
    // ✅ VERIFICAR ORDENS DE PROTEÇÃO
    console.log('\n🔍 4. Verificando ordens de proteção...');
    const [protectionOrders] = await db.query(`
      SELECT simbolo, tipo_ordem_bot, COUNT(*) as count
      FROM ordens 
      WHERE conta_id = $1 AND status IN ('NEW', 'PARTIALLY_FILLED')
        AND tipo_ordem_bot IN ('STOP_LOSS', 'RP1', 'RP2', 'RP3', 'RP4', 'TP')
      GROUP BY simbolo, tipo_ordem_bot
      ORDER BY simbolo
    `, [accountId]);
    
    console.log(`📊 Encontradas ${protectionOrders.length} ordens de proteção ativas`);
    
    if (protectionOrders.length > 0) {
      console.log('\n📋 Ordens de proteção por símbolo:');
      const protectionBySymbol = {};
      protectionOrders.forEach(order => {
        if (!protectionBySymbol[order.simbolo]) {
          protectionBySymbol[order.simbolo] = [];
        }
        protectionBySymbol[order.simbolo].push(`${order.tipo_ordem_bot} (${order.count})`);
      });
      
      Object.entries(protectionBySymbol).forEach(([symbol, orders]) => {
        console.log(`  ${symbol}: ${orders.join(', ')}`);
      });
    }
    
    // ✅ VERIFICAR SINAIS DISPONÍVEIS
    console.log('\n🔍 5. Verificando sinais disponíveis...');
    const symbolsFromExchange = [...new Set(exchangePositions.map(pos => pos.simbolo))];
    const signalsInfo = [];
    
    for (const symbol of symbolsFromExchange) {
      const [signals] = await db.query(`
        SELECT id, symbol, side, sl_price, tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, tp_price, created_at
        FROM webhook_signals 
        WHERE symbol = $1 AND conta_id = $2 
        ORDER BY created_at DESC 
        LIMIT 1
      `, [symbol, accountId]);
      
      if (signals.length > 0) {
        const signal = signals[0];
        const ageMinutes = Math.floor((Date.now() - new Date(signal.created_at).getTime()) / (1000 * 60));
        const hasSlPrice = signal.sl_price && parseFloat(signal.sl_price) > 0;
        const hasTpPrices = [signal.tp1_price, signal.tp2_price, signal.tp3_price, signal.tp4_price, signal.tp5_price, signal.tp_price].some(price => price && parseFloat(price) > 0);
        
        signalsInfo.push({
          symbol,
          signalId: signal.id,
          age: ageMinutes,
          hasSlPrice,
          hasTpPrices,
          side: signal.side
        });
      } else {
        signalsInfo.push({
          symbol,
          signalId: null,
          age: null,
          hasSlPrice: false,
          hasTpPrices: false,
          side: null
        });
      }
    }
    
    console.log('\n📋 Sinais por símbolo:');
    signalsInfo.forEach(info => {
      if (info.signalId) {
        const pricesAvailable = [];
        if (info.hasSlPrice) pricesAvailable.push('SL');
        if (info.hasTpPrices) pricesAvailable.push('TP');
        
        console.log(`  ${info.symbol}: Sinal ID=${info.signalId} (${info.age} min) - ${info.side} - Preços: ${pricesAvailable.join(', ') || 'Nenhum'}`);
      } else {
        console.log(`  ${info.symbol}: ❌ Nenhum sinal encontrado`);
      }
    });
    
    // ✅ EXECUTAR DETECÇÃO DE ÓRFÃS
    console.log('\n🔍 6. Executando detecção de posições órfãs...');
    console.log('=' .repeat(50));
    
    if (TEST_MODE) {
      console.log('🚨 MODO TESTE ATIVO - Simulando detecção sem criar ordens');
      // Simular lógica de detecção...
      let simulatedOrphans = 0;
      
      for (const position of exchangePositions) {
        const symbol = position.simbolo;
        const positionAge = position.tempoAbertura ? Date.now() - position.tempoAbertura : 0;
        const ageMinutes = Math.floor(positionAge / (1000 * 60));
        
        console.log(`\n🔍 Simulando ${symbol}:`);
        
        // Critério 1: Idade
        if (ageMinutes < 4) {
          console.log(`  ⏳ Muito nova (${ageMinutes} min) - SKIP`);
          continue;
        }
        
        // Critério 2: Ordens abertas (simulado)
        console.log(`  ✅ Idade ok (${ageMinutes} min)`);
        console.log(`  🔍 Verificando ordens abertas...`);
        
        // Critério 3: Posição no banco
        const dbPos = dbPositions.find(p => p.simbolo === symbol);
        if (dbPos) {
          console.log(`  ✅ Posição encontrada no banco (ID: ${dbPos.id})`);
          
          // Verificar ordens de proteção
          const hasProtection = protectionOrders.some(order => order.simbolo === symbol);
          if (hasProtection) {
            console.log(`  ✅ Tem ordens de proteção - NÃO É ÓRFÃ`);
            continue;
          } else {
            console.log(`  ⚠️ SEM ordens de proteção - ÓRFÃ DETECTADA!`);
          }
        } else {
          console.log(`  ⚠️ Posição NÃO encontrada no banco - ÓRFÃ DETECTADA!`);
        }
        
        // Critério 4: Sinal disponível
        const signalInfo = signalsInfo.find(s => s.symbol === symbol);
        if (signalInfo && signalInfo.signalId && (signalInfo.hasSlPrice || signalInfo.hasTpPrices)) {
          console.log(`  ✅ Sinal disponível com preços - ÓRFÃ PODE SER CORRIGIDA`);
          simulatedOrphans++;
        } else {
          console.log(`  ❌ Sinal não disponível ou sem preços - ÓRFÃ NÃO PODE SER CORRIGIDA`);
        }
      }
      
      console.log(`\n📊 RESULTADO DA SIMULAÇÃO:`);
      console.log(`  🔍 Posições verificadas: ${exchangePositions.length}`);
      console.log(`  ⚠️ Órfãs detectadas: ${simulatedOrphans}`);
      console.log(`\n💡 Para executar correção real, rode sem --dry-run`);
      
    } else {
      // ✅ EXECUÇÃO REAL
      console.log('🚀 EXECUTANDO CORREÇÃO REAL...');
      
      const orphanResults = await detectAndFixOrphanPositions(accountId);
      
      console.log('\n📊 RESULTADO DA EXECUÇÃO:');
      console.log(`  🔍 Posições processadas: ${orphanResults.processed}`);
      console.log(`  🔧 Órfãs corrigidas: ${orphanResults.fixed}`);
      console.log(`  ❌ Erros: ${orphanResults.errors.length}`);
      
      if (orphanResults.errors.length > 0) {
        console.log('\n📋 Detalhes dos erros:');
        orphanResults.errors.forEach((error, index) => {
          console.log(`  ${index + 1}. ${error}`);
        });
      }
      
      if (orphanResults.fixed > 0) {
        console.log('\n✅ Posições órfãs foram corrigidas com sucesso!');
        console.log('💡 Verifique as ordens criadas na interface da corretora');
      } else if (orphanResults.processed > 0) {
        console.log('\n✅ Todas as posições estão adequadamente protegidas');
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('🧪 TESTE CONCLUÍDO COM SUCESSO!');
    
  } catch (error) {
    console.error('\n❌ ERRO NO TESTE:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

/**
 * ✅ FUNÇÃO DE HELP
 */
function showHelp() {
  console.log(`
🧪 TESTE: Sistema de Detecção de Posições Órfãs

USO:
  node test-orphan-positions.js [accountId] [opções]

PARÂMETROS:
  accountId    ID da conta para testar (padrão: 1)

OPÇÕES:
  --dry-run    Apenas simular, sem criar ordens reais
  --help       Mostrar esta ajuda

EXEMPLOS:
  node test-orphan-positions.js 1           # Testar conta 1 (execução real)
  node test-orphan-positions.js 2 --dry-run # Simular teste na conta 2
  node test-orphan-positions.js --help      # Mostrar ajuda

CRITÉRIOS PARA POSIÇÃO ÓRFÃ:
• Posição existe na corretora há mais de 4 minutos
• Não tem ordens abertas na corretora
• Não tem ordens de proteção (SL/TP) no banco OU não existe no banco
• Existe um sinal com preços de SL/TP para o símbolo

FUNCIONAMENTO:
1. Verifica todas as posições na corretora
2. Identifica posições sem ordens de proteção adequadas
3. Busca o último sinal para o símbolo
4. Cria ordens SL, RP1-4 e TP baseadas no sinal
5. Salva as ordens no banco de dados
  `);
}

// ✅ EXECUTAR TESTE
if (require.main === module) {
  if (process.argv.includes('--help')) {
    showHelp();
    process.exit(0);
  }
  
  testOrphanPositionDetection()
    .then(() => {
      console.log('\n👋 Teste finalizado');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Erro fatal:', error.message);
      process.exit(1);
    });
}

module.exports = {
  testOrphanPositionDetection,
  showHelp
};
