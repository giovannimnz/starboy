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

// Função para testar a WebSocket API
function testarWebSocketApi(url, descricao) {
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
      ws = new WebSocket(url);
      
      ws.on('open', () => {
        console.log(`✅ ${descricao} funcionando! Conexão WebSocket estabelecida com sucesso.`);
        clearTimeout(timeout);
        
        // Enviar ping simples
        if (url.includes('ws-api') || url.includes('ws-fapi')) {
          // WebSocket API (FAPI) - usar formato de requisição adequado
          const pingRequest = {
            id: '1',
            method: 'ping'
          };
          ws.send(JSON.stringify(pingRequest));
          
          // Esperar um pouco antes de fechar
          setTimeout(() => {
            ws.close();
            resolve(true);
          }, 1000);
        } else {
          // WebSocket de market data (simples)
          // Fechar após conexão com sucesso
          ws.close();
          resolve(true);
        }
      });
      
      ws.on('message', (data) => {
        console.log(`✅ ${descricao} resposta recebida: ${data}`);
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

// Função principal
async function verificarCorretoras() {
  try {
    console.log("=== VERIFICAÇÃO DE URLS DAS CORRETORAS ===");
    
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
      await testarWebSocketApi(corretora.futures_ws_market_url, "WebSocket Market Stream");
      
      // Testar URL WebSocket API
      await testarWebSocketApi(corretora.futures_ws_api_url + '/v1', "WebSocket API (FAPI)");
      
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
        for (const conta of contas) {
          console.log(`  - Conta ID ${conta.id}`);
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
    
    console.log("\nVerificação de corretoras concluída.");
  } catch (error) {
    console.error("Erro durante a verificação:", error);
  }
}

// Executar a função principal
verificarCorretoras();