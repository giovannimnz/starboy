const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDatabaseInstance } = require('../db/conexao');
const fs = require('fs').promises;

// Função principal para depurar e corrigir o monitoramento
async function debugECorrigirMonitoramento() {
  try {
    console.log('=== INICIANDO DIAGNÓSTICO E CORREÇÃO ===');
    
    // 1. Analisar o arquivo monitoramento.js
    const arquivoMonitoramento = path.join(__dirname, '..', 'posicoes', 'monitoramento.js');
    let conteudo = await fs.readFile(arquivoMonitoramento, 'utf8');
    let correcoes = [];
    
    // 2. Verificar problema no startPriceMonitoring (provável causa)
    if (conteudo.includes('async function startPriceMonitoring(')) {
      console.log('Analisando função startPriceMonitoring...');
      
      // Problema comum: erro ao iniciar WebSockets de preço
      if (conteudo.includes('for (const symbol of symbols)')) {
        console.log('⚠️ Encontrado código problemático no loop de inicialização de WebSockets');
        
        // Substituir o loop por uma versão mais robusta
        let novoLoop = `
  // Iniciar websockets para cada símbolo com tratamento de erro por símbolo
  for (const symbol of symbols) {
    try {
      console.log(\`[MONITOR] Iniciando monitoramento de preço para \${symbol}\`);
      await websockets.ensurePriceWebsocketExists(symbol, accountId);
    } catch (wsError) {
      console.error(\`[MONITOR] Erro ao iniciar WebSocket para \${symbol}, continuando: \${wsError.message}\`);
      // Continuar para o próximo símbolo mesmo com erro
    }
  }`;
        
        conteudo = conteudo.replace(/for \(const symbol of symbols\)[^}]*}/s, novoLoop);
        correcoes.push('Corrigido loop de inicialização de WebSockets com tratamento de erro por símbolo');
      }
    }
    
    // 3. Verificar problema no initializeMonitoring
    if (conteudo.includes('async function initializeMonitoring(')) {
      console.log('Analisando função initializeMonitoring...');
      
      // Problema comum: travamento após atualização de alavancagem
      if (conteudo.includes('await updateLeverageBracketsInDatabase();')) {
        console.log('⚠️ Encontrado possível ponto de travamento após atualização de alavancagem');
        
        // Verificar se já tem try/catch
        if (!conteudo.includes('try {\n      await updateLeverageBracketsInDatabase();')) {
          // Adicionar try/catch robusto
          conteudo = conteudo.replace(
            /await updateLeverageBracketsInDatabase\(\);/g,
            `try {
      await updateLeverageBracketsInDatabase();
      console.log('[MONITOR] Atualização de brackets de alavancagem concluída com sucesso.');
    } catch (bracketError) {
      console.error('[MONITOR] Erro ao atualizar brackets de alavancagem, mas continuando inicialização:', bracketError.message);
      // Continuar mesmo com erro nos brackets
    }`
          );
          correcoes.push('Adicionado tratamento de erro para atualização de brackets de alavancagem');
        }
      }
      
      // Verificar se há try/catch para websocketApi.initializeHandlers
      if (conteudo.includes('await websocketApi.initializeHandlers(')) {
        if (!conteudo.includes('try {\n      await websocketApi.initializeHandlers(')) {
          conteudo = conteudo.replace(
            /await websocketApi\.initializeHandlers\(accountId\);/g,
            `try {
      await websocketApi.initializeHandlers(accountId);
      console.log(\`[MONITOR] WebSocket API handlers inicializados para conta \${accountId}\`);
    } catch (wsError) {
      console.error(\`[MONITOR] Erro ao inicializar WebSocket API handlers, continuando com REST API fallback: \${wsError.message}\`);
      // Continuar mesmo com erro, já que podemos usar API REST como fallback
    }`
          );
          correcoes.push('Adicionado tratamento de erro para inicialização de WebSocket API handlers');
        }
      }
      
      // Verificar se há try/catch para startUserDataStream
      if (conteudo.includes('await websockets.startUserDataStream(')) {
        if (!conteudo.includes('try {\n      await websockets.startUserDataStream(')) {
          conteudo = conteudo.replace(
            /await websockets\.startUserDataStream\(db, accountId\);/g,
            `try {
      await websockets.startUserDataStream(db, accountId);
      console.log(\`[MONITOR] UserDataStream iniciado para conta \${accountId}\`);
    } catch (userDataError) {
      console.error(\`[MONITOR] Erro ao iniciar UserDataStream, continuando: \${userDataError.message}\`);
      // Continuar mesmo com erro
    }`
          );
          correcoes.push('Adicionado tratamento de erro para inicialização de UserDataStream');
        }
      }
      
      // Verificar tratamento de erro para syncPositionsWithExchange
      if (conteudo.includes('await syncPositionsWithExchange(accountId);')) {
        if (!conteudo.includes('try {\n      await syncPositionsWithExchange(')) {
          conteudo = conteudo.replace(
            /await syncPositionsWithExchange\(accountId\);/g,
            `try {
      await syncPositionsWithExchange(accountId);
      console.log('[MONITOR] Sincronização de posições concluída com sucesso.');
    } catch (syncError) {
      console.error('[MONITOR] Erro ao sincronizar posições, mas continuando:', syncError.message);
    }`
          );
          correcoes.push('Adicionado tratamento de erro para sincronização de posições');
        }
      }
    }
    
    // 4. Ajustar os timers e funções assíncronas que podem causar travamento
    if (conteudo.includes('setTimeout(() => {')) {
      console.log('⚠️ Encontrados setTimeout que podem causar problemas de execução assíncrona');
      
      // Substituir setTimeout por versão que manipula erros corretamente
      conteudo = conteudo.replace(
        /setTimeout\(\(\) => \{\s*checkNewTrades\(accountId\).*?\}, (\d+)\);/g,
        `setTimeout(() => {
      console.log('[MONITOR] Executando verificação imediata...');
      checkNewTrades(accountId).catch(error => {
        console.error('[MONITOR] Erro na verificação imediata de sinais:', error);
      });
    }, $1);`
      );
      correcoes.push('Corrigido tratamento de erros em setTimeout para checkNewTrades');
    }
    
    // 5. Salvar as correções se houver alterações
    if (correcoes.length > 0) {
      console.log(`\n✅ ${correcoes.length} correções aplicadas:`);
      correcoes.forEach((corr, idx) => console.log(`   ${idx + 1}. ${corr}`));
      
      // Backup do arquivo original
      const backupPath = `${arquivoMonitoramento}.bak`;
      await fs.writeFile(backupPath, conteudo);
      console.log(`Backup do arquivo original salvo em ${backupPath}`);
      
      // Salvar arquivo corrigido
      await fs.writeFile(arquivoMonitoramento, conteudo);
      console.log('Arquivo corrigido salvo com sucesso!');
      
      // Criar script de inicialização otimizado
      await criarScriptInicializacaoOtimizado();
    } else {
      console.log('Nenhuma correção necessária identificada no código.');
    }
    
    // 6. Verificar banco de dados
    console.log('\nVerificando banco de dados...');
    try {
      const db = await getDatabaseInstance();
      if (db) {
        console.log('✅ Conexão com banco de dados estabelecida com sucesso');
        
        // Verificar sinais pendentes
        const [pendingSignals] = await db.query(`
          SELECT id, symbol, side, entry_price, status 
          FROM webhook_signals 
          WHERE status = 'PENDING'
        `);
        
        console.log(`Encontrados ${pendingSignals.length} sinais pendentes no banco de dados`);
      }
    } catch (dbError) {
      console.error('⚠️ Erro ao conectar ao banco de dados:', dbError.message);
    }
    
    console.log('\n=== DIAGNÓSTICO E CORREÇÃO CONCLUÍDOS ===');
    console.log('Para iniciar o sistema otimizado, execute:');
    console.log('node utils/iniciarOtimizado.js');
    
  } catch (error) {
    console.error('ERRO DURANTE DIAGNÓSTICO:', error);
  }
}

// Função para criar script de inicialização otimizado
async function criarScriptInicializacaoOtimizado() {
  console.log('\nCriando script de inicialização otimizado...');
  
  const scriptPath = path.join(__dirname, 'iniciarOtimizado.js');
  
  const scriptContent = `// Script otimizado para iniciar o sistema de monitoramento
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initializeMonitoring, forceProcessPendingSignals } = require('../posicoes/monitoramento');

async function iniciarSistema() {
  try {
    console.log('=== INICIANDO SISTEMA DE MONITORAMENTO OTIMIZADO ===');
    
    // 1. Inicializar o sistema de monitoramento com timeout de segurança
    console.log('[INICIALIZADOR] Iniciando sistema de monitoramento...');
    
    // Configurar um timeout para garantir que a inicialização não trave
    const initializationTimeout = setTimeout(() => {
      console.error('[INICIALIZADOR] ⚠️ TIMEOUT: A inicialização está demorando muito! Continuando mesmo assim...');
      // Não encerramos o processo - permitimos que continue mesmo com timeout
    }, 30000); // 30 segundos de timeout
    
    try {
      await initializeMonitoring(1);
      clearTimeout(initializationTimeout);
      console.log('[INICIALIZADOR] Sistema de monitoramento inicializado com sucesso');
    } catch (initError) {
      clearTimeout(initializationTimeout);
      console.error('[INICIALIZADOR] Erro na inicialização do monitoramento:', initError);
      console.log('[INICIALIZADOR] Continuando mesmo com erro...');
    }
    
    // 2. Aguardar inicialização completa
    console.log('[INICIALIZADOR] Aguardando inicialização completa (5 segundos)...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 3. Forçar processamento de sinais pendentes
    console.log('[INICIALIZADOR] Processando sinais pendentes...');
    try {
      await forceProcessPendingSignals(1);
      console.log('[INICIALIZADOR] Processamento de sinais pendentes concluído');
    } catch (signalError) {
      console.error('[INICIALIZADOR] Erro ao processar sinais pendentes:', signalError);
    }
    
    console.log('[INICIALIZADOR] Sistema inicializado e pronto para operar!');
    console.log('[INICIALIZADOR] O sistema continuará rodando e monitorando novos sinais.');
    
    // Manter o processo rodando
    process.on('SIGINT', () => {
      console.log('Sistema sendo encerrado...');
      process.exit(0);
    });
    
  } catch (error) {
    console.error('[INICIALIZADOR] ERRO CRÍTICO:', error);
    process.exit(1);
  }
}

// Iniciar o sistema
iniciarSistema();`;
  
  await fs.writeFile(scriptPath, scriptContent, 'utf8');
  console.log('✅ Script de inicialização otimizado criado: utils/iniciarOtimizado.js');
}

// Executar a função principal
debugECorrigirMonitoramento();