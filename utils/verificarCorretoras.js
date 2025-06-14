const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDatabaseInstance, getCorretoraPorId } = require('../db/conexao');
const axios = require('axios');

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

// Função principal
async function verificarCorretoras() {
  try {
    console.log("=== VERIFICAÇÃO DE URLS DAS CORRETORAS ===");
    
    // Conectar ao banco de dados
    const db = await getDatabaseInstance();
    console.log("Conexão com banco de dados estabelecida");
    
    // Obter todas as corretoras ativas
    const [corretoras] = await db.query(
      "SELECT id, corretora, ambiente, spot_rest_api_url, futures_rest_api_url FROM corretoras WHERE ativa = 1"
    );
    
    if (corretoras.length === 0) {
      console.log("Nenhuma corretora ativa encontrada no banco de dados.");
      return;
    }
    
    console.log(`Encontradas ${corretoras.length} corretoras ativas:\n`);
    
    // Verificar cada corretora
    for (const corretora of corretoras) {
      console.log(`\n=== Corretora: ${corretora.corretora} (ID: ${corretora.id}, Ambiente: ${corretora.ambiente}) ===`);
      
      // Testar URLs
      await testarApiUrl(corretora.spot_rest_api_url, "API REST Spot");
      await testarApiUrl(corretora.futures_rest_api_url, "API REST Futures");
      
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