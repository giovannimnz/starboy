const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDatabaseInstance } = require('../db/conexao');
const { initializeMonitoring, forceProcessPendingSignals } = require('../posicoes/monitoramento');

async function verificarAmbiente() {
  try {
    console.log('[VERIFICAÇÃO] Verificando consistência de ambiente...');
    
    const db = await getDatabaseInstance();
    
    // Verificar URL do WebSocket API
    const [corretora] = await db.query(`
      SELECT c.futures_rest_api_url, c.futures_ws_api_url, c.ambiente
      FROM corretoras c 
      WHERE c.id = 1 AND c.ativa = 1
    `);
    
    if (corretora.length > 0) {
      const { futures_rest_api_url, futures_ws_api_url, ambiente } = corretora[0];
      
      const isRestProduction = !futures_rest_api_url.includes('testnet');
      const isWsApiProduction = !futures_ws_api_url.includes('testnet');
      
      if (ambiente === 'prd' && !isWsApiProduction) {
        console.log('[VERIFICAÇÃO] ⚠️ Corretora em ambiente de produção, mas WebSocket API em testnet!');
        console.log('[VERIFICAÇÃO] Corrigindo URL do WebSocket API...');
        
        await db.query(`
          UPDATE corretoras 
          SET futures_ws_api_url = 'wss://fstream.binance.com/ws-api/v3' 
          WHERE id = 1 AND ambiente = 'prd'
        `);
        
        console.log('[VERIFICAÇÃO] ✅ URL do WebSocket API corrigida para produção');
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('[VERIFICAÇÃO] Erro ao verificar ambiente:', error);
    return false;
  }
}

async function iniciarSistema() {
  try {
    console.log('=== INICIANDO SISTEMA COM VERIFICAÇÕES DE SEGURANÇA ===');
    
    // Verificar ambiente antes de iniciar
    const ambienteCorrigido = await verificarAmbiente();
    
    if (ambienteCorrigido) {
      console.log('[INICIALIZADOR] Ambiente corrigido, aguardando 3 segundos antes de iniciar...');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Iniciar sistema com timeout de segurança
    console.log('[INICIALIZADOR] Iniciando sistema de monitoramento...');
    
    const initTimeout = setTimeout(() => {
      console.warn('[INICIALIZADOR] ⚠️ Timeout ao inicializar sistema!');
    }, 60000);
    
    await initializeMonitoring(1);
    clearTimeout(initTimeout);
    
    console.log('[INICIALIZADOR] Sistema inicializado com sucesso. Aguardando 5 segundos...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('[INICIALIZADOR] Processando sinais pendentes...');
    await forceProcessPendingSignals(1);
    
    console.log('[INICIALIZADOR] Sistema pronto e operacional!');
    
  } catch (error) {
    console.error('[INICIALIZADOR] Erro crítico:', error);
    process.exit(1);
  }
}

// Iniciar sistema
iniciarSistema();