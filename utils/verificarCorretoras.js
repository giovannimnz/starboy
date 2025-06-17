const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDatabaseInstance, getCorretoraPorId } = require('../db/conexao');
const axios = require('axios');
const WebSocket = require('ws');

// Função para testar a URL da API REST
async function testarApiUrl(url, descricao) {
  try {
    console.log(`Testando ${descricao}: ${url}`);
    const response = await axios.get(`${url}/v1/time`);
    if (response.data && response.data.serverTime) {
      console.log(`✅ ${descricao} funcionando! Server time: ${new Date(response.data.serverTime).toLocaleString()}`);
      return true;
    } else {
      console.log(`❌ ${descricao} resposta sem serverTime: ${JSON.stringify(response.data)}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Erro ao testar ${descricao}: ${error.message}`);
    return false;
  }
}

// Função para testar a WebSocket Market Stream
function testarWebSocketMarket(url, descricao) {
  return new Promise((resolve) => {
    console.log(`Testando ${descricao}: ${url}`);
    
    // Configurar timeout para caso a conexão demorar demais
    const timeout = setTimeout(() => {
      console.log(`❌ ${descricao} timeout após 10 segundos`);
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      resolve(false);
    }, 10000);
    
    // Tentar conectar
    let ws;
    try {
      // Para WebSocket Market Stream, adicionar um símbolo e stream específico
      let wsUrl = url;
      if (url.includes('fstream.binance.com') || url.includes('stream.binancefuture.com')) {
        wsUrl = `${url}/ws/btcusdt@bookTicker`;
      }
      
      ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        console.log(`✅ ${descricao} funcionando! Conexão WebSocket estabelecida com sucesso.`);
        clearTimeout(timeout);
        
        // Fechar após conexão com sucesso
        setTimeout(() => {
          ws.close();
          resolve(true);
        }, 1000);
      });
      
      ws.on('message', (data) => {
        console.log(`✅ ${descricao} resposta recebida`);
      });
      
      ws.on('error', (error) => {
        console.error(`❌ ${descricao} erro de conexão: ${error.message}`);
        clearTimeout(timeout);
        resolve(false);
      });
      
      ws.on('close', () => {
        console.log(`WebSocket fechado para ${descricao}`);
      });
    } catch (error) {
      console.error(`❌ Erro ao iniciar teste para ${descricao}: ${error.message}`);
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

// NOVA FUNÇÃO: Testar WebSocket API (para comandos de trading)
function testarWebSocketApi(url, descricao) {
  return new Promise((resolve) => {
    console.log(`Testando ${descricao}: ${url}`);
    
    // Configurar timeout
    const timeout = setTimeout(() => {
      console.log(`❌ ${descricao} timeout após 15 segundos`);
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      resolve(false);
    }, 15000);
    
    let ws;
    try {
      // Conectar diretamente à URL da WebSocket API
      ws = new WebSocket(url);
      
      ws.on('open', () => {
        console.log(`✅ ${descricao} conexão estabelecida! Testando comando básico...`);
        
        // Enviar uma requisição de teste (ping ou time)
        const testRequest = {
          id: `test-${Date.now()}`,
          method: 'time',
          params: {}
        };
        
        try {
          ws.send(JSON.stringify(testRequest));
        } catch (sendError) {
          console.error(`❌ ${descricao} erro ao enviar comando: ${sendError.message}`);
          clearTimeout(timeout);
          ws.close();
          resolve(false);
        }
      });
      
      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data);
          
          if (response.id && response.id.startsWith('test-')) {
            if (response.status === 200 && response.result && response.result.serverTime) {
              console.log(`✅ ${descricao} funcionando perfeitamente! Server time: ${new Date(response.result.serverTime).toLocaleString()}`);
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            } else if (response.error) {
              console.log(`⚠️ ${descricao} conectou mas retornou erro: ${response.error.code} - ${response.error.msg}`);
              // Isso ainda indica que a conexão funciona, apenas pode precisar de autenticação
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            } else {
              console.log(`⚠️ ${descricao} resposta inesperada:`, JSON.stringify(response));
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            }
          }
        } catch (parseError) {
          console.log(`⚠️ ${descricao} resposta não é JSON válido: ${data}`);
          // Ainda assim indica que a conexão funciona
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      });
      
      ws.on('error', (error) => {
        console.error(`❌ ${descricao} erro de conexão: ${error.message}`);
        clearTimeout(timeout);
        resolve(false);
      });
      
      ws.on('close', (code, reason) => {
        console.log(`WebSocket API fechado para ${descricao} (código: ${code})`);
        clearTimeout(timeout);
      });
      
    } catch (error) {
      console.error(`❌ Erro ao iniciar teste para ${descricao}: ${error.message}`);
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

// NOVA FUNÇÃO: Validar credenciais da conta na WebSocket API
async function validarCredenciaisConta(contaId, corretora) {
  try {
    console.log(`\n=== Validando Credenciais da Conta ${contaId} ===`);
    
    const db = await getDatabaseInstance();
    const [contas] = await db.query(`
      SELECT c.id, c.api_key, c.api_secret, c.ws_api_key, c.ws_api_secret, c.private_key,
             cor.futures_ws_api_url, cor.ambiente, cor.corretora
      FROM contas c
      JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ? AND c.ativa = 1
    `, [contaId]);
    
    if (contas.length === 0) {
      console.log(`❌ Conta ${contaId} não encontrada ou não está ativa`);
      return false;
    }
    
    const conta = contas[0];
    
    console.log(`Conta ${contaId} (${conta.corretora} - ${conta.ambiente}):`);
    console.log(`- API Key: ${conta.api_key ? `${conta.api_key.substring(0, 8)}...` : '❌ Não configurada'}`);
    console.log(`- API Secret: ${conta.api_secret ? '✅ Configurada' : '❌ Não configurada'}`);
    console.log(`- WS API Key: ${conta.ws_api_key ? `${conta.ws_api_key.substring(0, 8)}...` : '❌ Não configurada'}`);
    console.log(`- WS API Secret (Ed25519): ${conta.ws_api_secret ? '✅ Configurada' : '❌ Não configurada'}`);
    console.log(`- Private Key: ${conta.private_key ? '✅ Configurada' : '❌ Não configurada'}`);
    
    // Verificar se as credenciais estão completas
    let credenciaisCompletas = true;
    
    if (!conta.api_key || !conta.api_secret) {
      console.log(`⚠️ Credenciais REST API incompletas para conta ${contaId}`);
      credenciaisCompletas = false;
    }
    
    if (!conta.ws_api_secret && !conta.private_key) {
      console.log(`⚠️ Chave privada Ed25519 não configurada para conta ${contaId} - WebSocket API não funcionará completamente`);
      credenciaisCompletas = false;
    }
    
    if (credenciaisCompletas) {
      console.log(`✅ Todas as credenciais estão configuradas para conta ${contaId}`);
    }
    
    return credenciaisCompletas;
    
  } catch (error) {
    console.error(`❌ Erro ao validar credenciais da conta ${contaId}:`, error.message);
    return false;
  }
}

// Função principal
async function verificarCorretoras() {
  try {
    console.log("=== VERIFICAÇÃO COMPLETA DE CORRETORAS E CREDENCIAIS ===");
    
    // Conectar ao banco de dados
    const db = await getDatabaseInstance();
    console.log("Conexão com banco de dados estabelecida");
    
    // Obter todas as corretoras ativas
    const [corretoras] = await db.query(
      "SELECT id, corretora, ambiente, spot_rest_api_url, futures_rest_api_url, futures_ws_market_url, futures_ws_api_url FROM corretoras WHERE ativa = 1"
    );
    
    if (corretoras.length === 0) {
      console.log("Nenhuma corretora ativa encontrada no banco de dados.");
      return;
    }
    
    console.log(`Encontradas ${corretoras.length} corretoras ativas:\n`);
    
    // Verificar cada corretora
    for (const corretora of corretoras) {
      console.log(`\n=== Corretora: ${corretora.corretora} (ID: ${corretora.id}, Ambiente: ${corretora.ambiente}) ===`);
      
      // Testar URLs REST
      await testarApiUrl(corretora.futures_rest_api_url, "API REST Futures");
      
      // Testar URL WebSocket Market (Stream)
      await testarWebSocketMarket(corretora.futures_ws_market_url, "WebSocket Market Stream");
      
      // Testar URL WebSocket API - garantir que termina com /v1
      let wsApiUrl = corretora.futures_ws_api_url;
      if (!wsApiUrl.endsWith('/v1')) {
        wsApiUrl = `${wsApiUrl}/v1`;
      }
      
      await testarWebSocketApi(wsApiUrl, "WebSocket API (Trading Commands)");
      
      // Verificar se as URLs estão sendo utilizadas corretamente
      console.log("\nVerificando se alguma conta usa esta corretora...");
      const [contas] = await db.query(
        "SELECT id, id_corretora FROM contas WHERE id_corretora = ? AND ativa = 1",
        [corretora.id]
      );
      
      if (contas.length === 0) {
        console.log(`❗ Nenhuma conta ativa está usando a corretora ID ${corretora.id}`);
      } else {
        console.log(`✅ ${contas.length} contas ativas usando a corretora ID ${corretora.id}`);
        
        // Validar credenciais de cada conta
        for (const conta of contas) {
          await validarCredenciaisConta(conta.id, corretora);
        }
      }
    }
    
    // Verificar contas sem corretora definida
    const [contasSemCorretora] = await db.query(
      "SELECT id FROM contas WHERE (id_corretora IS NULL OR id_corretora = 0) AND ativa = 1"
    );
    
    if (contasSemCorretora.length > 0) {
      console.log(`\n⚠️ ALERTA: Encontradas ${contasSemCorretora.length} contas ativas sem corretora definida!`);
      for (const conta of contasSemCorretora) {
        console.log(`  - Conta ID ${conta.id} não tem corretora definida (será usada corretora ID 1 por padrão)`);
        
        // Opção: atualizar automaticamente para corretora ID 1
        await db.query(
          "UPDATE contas SET id_corretora = 1 WHERE id = ?",
          [conta.id]
        );
        console.log(`    ✅ Atualizada automaticamente para usar corretora ID 1`);
      }
    } else {
      console.log("\n✅ Todas as contas ativas têm uma corretora definida!");
    }
    
    console.log("\n=== RESUMO DA VERIFICAÇÃO ===");
    console.log("✅ Verificação de APIs REST completa");
    console.log("✅ Verificação de WebSocket Market Streams completa");
    console.log("✅ Verificação de WebSocket APIs (Trading) completa");
    console.log("✅ Verificação de credenciais das contas completa");
    console.log("\nVerificação de corretoras concluída.");
    
  } catch (error) {
    console.error("Erro durante a verificação:", error);
  }
}

// Executar a função principal
verificarCorretoras();