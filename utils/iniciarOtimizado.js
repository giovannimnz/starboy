// Script otimizado para iniciar o sistema de monitoramento
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
iniciarSistema();