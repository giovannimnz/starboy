const fs = require('fs').promises;
const path = require('path');
const { getDatabaseInstance } = require('../db/conexao');

async function aplicarCorrecoes() {
  try {
    console.log('=== INICIANDO CORREÇÕES DO SISTEMA DE MONITORAMENTO ===');
    
    // 1. Corrigir configuração de ambiente WebSocket API
    await corrigirAmbienteWebSocket();
    
    // 2. Corrigir referência da API em processSignal
    await corrigirReferenciaApi();
    
    // 3. Corrigir inicialização do monitoramento
    await corrigirInicializacao();
    
    // 4. Criar script otimizado de inicialização
    await criarScriptInicializacao();
    
    console.log('\n=== CORREÇÕES APLICADAS COM SUCESSO ===');
    console.log('Para iniciar o sistema corrigido, execute:');
    console.log('node utils/iniciarOtimizado.js');
    
  } catch (error) {
    console.error('ERRO DURANTE CORREÇÃO:', error);
  }
}

// Corrigir ambiente WebSocket (produção vs testnet)
async function corrigirAmbienteWebSocket() {
  console.log('\n[CORREÇÃO 1] Verificando configuração de ambiente...');
  
  const db = await getDatabaseInstance();
  
  // Verificar configuração atual
  const [corretora] = await db.query(
    'SELECT id, corretora, ambiente, futures_rest_api_url, futures_ws_api_url FROM corretoras WHERE id = 1'
  );
  
  if (corretora.length === 0) {
    console.log('Corretora ID 1 não encontrada');
    return;
  }
  
  // Verificar se ambiente está consistente
  const isRestProd = !corretora[0].futures_rest_api_url.includes('testnet');
  const isWsTestnet = corretora[0].futures_ws_api_url.includes('testnet');
  
  if (isRestProd && isWsTestnet) {
    console.log('⚠️ Detectada inconsistência: REST API em produção mas WebSocket API em testnet');
    
    // Corrigir para ambiente de produção
    await db.query(
      'UPDATE corretoras SET futures_ws_api_url = ? WHERE id = 1',
      ['wss://fstream.binance.com/ws-api/v3']
    );
    
    console.log('✅ URL do WebSocket API corrigida para produção');
  } else {
    console.log('✅ Configuração de ambiente está consistente');
  }
}

// Corrigir referência da API em processSignal
async function corrigirReferenciaApi() {
  console.log('\n[CORREÇÃO 2] Corrigindo referência "api is not defined"...');
  
  const monitoramentoPath = path.join(__dirname, '..', 'posicoes', 'monitoramento.js');
  let conteudo = await fs.readFile(monitoramentoPath, 'utf8');
  
  // Adicionar importação da API no início da função processSignal
  if (conteudo.includes('async function processSignal')) {
    conteudo = conteudo.replace(
      /async function processSignal\(db, signal, currentPrice, accountId = 1\) \{/,
      `async function processSignal(db, signal, currentPrice, accountId = 1) {
  // Importar API para garantir que está definido
  const api = require('../api');`
    );
    
    // Garantir que as chamadas usam o objeto api
    conteudo = conteudo.replace(
      /await changeInitialLeverage\(accountId, symbol, leverageLevel\);/g,
      `await api.changeInitialLeverage(accountId, symbol, leverageLevel);`
    );
    
    conteudo = conteudo.replace(
      /await changeMarginType\(accountId, symbol, 'CROSSED'\);/g,
      `await api.changeMarginType(accountId, symbol, 'CROSSED');`
    );
    
    await fs.writeFile(monitoramentoPath, conteudo, 'utf8');
    console.log('✅ Referência "api is not defined" corrigida');
  }
}

// Corrigir inicialização do monitoramento
async function corrigirInicializacao() {
  console.log('\n[CORREÇÃO 3] Otimizando inicialização do monitoramento...');
  
  const monitoramentoPath = path.join(__dirname, '..', 'posicoes', 'monitoramento.js');
  let conteudo = await fs.readFile(monitoramentoPath, 'utf8');
  
  // 1. Adicionar tratamento de erro para updateLeverageBracketsInDatabase
  if (conteudo.includes('await updateLeverageBracketsInDatabase')) {
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
  }
  
  // 2. Adicionar logs de progresso e tratamento de erros
  if (conteudo.includes('const accountJobs = {};')) {
    conteudo = conteudo.replace(
      /const accountJobs = \{\};/g,
      `console.log('[MONITOR] Iniciando agendamento de jobs...');
      const accountJobs = {};`
    );
    
    conteudo = conteudo.replace(
      /await startPriceMonitoring\(accountId\);/g,
      `console.log('[MONITOR] Iniciando monitoramento de preços...');
      await startPriceMonitoring(accountId);
      console.log('[MONITOR] Monitoramento de preços iniciado com sucesso.');`
    );
    
    conteudo = conteudo.replace(
      /await syncPositionsWithExchange\(accountId\);/g,
      `console.log('[MONITOR] Iniciando sincronização de posições...');
      try {
        await syncPositionsWithExchange(accountId);
        console.log('[MONITOR] Sincronização de posições concluída com sucesso.');
      } catch (syncError) {
        console.error('[MONITOR] Erro ao sincronizar posições, mas continuando:', syncError.message);
      }`
    );
  }
  
  // 3. Adicionar verificação imediata de sinais pendentes
  if (conteudo.includes('// Executar verificação inicial de novas operações imediatamente')) {
    conteudo = conteudo.replace(
      /\/\/ Executar verificação inicial de novas operações imediatamente[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?\}, \d+\);/g,
      `// Executar verificação imediata de sinais pendentes
    console.log('[MONITOR] Agendando verificação imediata de sinais pendentes...');
    setTimeout(() => {
      console.log('[MONITOR] Executando verificação imediata...');
      // Forçar processamento dos sinais pendentes
      forceProcessPendingSignals(accountId).catch(error => {
        console.error('[MONITOR] Erro ao processar sinais pendentes:', error);
      });
    }, 5000);`
    );
  }
  
  // 4. Salvar alterações
  await fs.writeFile(monitoramentoPath, conteudo, 'utf8');
  console.log('✅ Inicialização do monitoramento otimizada');
}

// Criar script otimizado de inicialização
async function criarScriptInicializacao() {
  console.log('\n[CORREÇÃO 4] Criando script de inicialização otimizado...');
  
  const scriptPath = path.join(__dirname, 'iniciarOtimizado.js');
  
  const scriptContent = `// Script otimizado para iniciar o sistema de monitoramento
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initializeMonitoring, forceProcessPendingSignals } = require('../posicoes/monitoramento');

async function iniciarSistema() {
  try {
    console.log('=== INICIANDO SISTEMA DE MONITORAMENTO OTIMIZADO ===');
    
    // 1. Inicializar o sistema de monitoramento
    console.log('[INICIALIZADOR] Iniciando sistema de monitoramento...');
    await initializeMonitoring(1);
    
    // 2. Aguardar inicialização completa
    console.log('[INICIALIZADOR] Aguardando inicialização completa (5 segundos)...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 3. Forçar processamento de sinais pendentes
    console.log('[INICIALIZADOR] Processando sinais pendentes...');
    await forceProcessPendingSignals(1);
    
    console.log('[INICIALIZADOR] Sistema inicializado com sucesso!');
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

// Executar todas as correções
aplicarCorrecoes();