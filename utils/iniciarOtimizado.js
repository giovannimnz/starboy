// Script otimizado para iniciar o sistema de monitoramento
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
iniciarSistema();