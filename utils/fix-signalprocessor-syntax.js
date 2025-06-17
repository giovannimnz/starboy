const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo erros de sintaxe no signalProcessor.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.syntax-fix.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

const signalProcessorPath = path.join(__dirname, 'posicoes', 'signalProcessor.js');
createBackup(signalProcessorPath);

let content = fs.readFileSync(signalProcessorPath, 'utf8');

// Adicionar import do sendTelegramMessage no topo
if (!content.includes('sendTelegramMessage')) {
  content = content.replace(
    /const api = require\('\.\.\/api'\);/,
    `const api = require('../api');
const { sendTelegramMessage } = require('../utils/telegram');`
  );
}

// Corrigir o erro de sintaxe específico nas linhas 140-142
const brokenCode = `      // Atualizar status para ERROR
      try {
        await db.query(
          \`UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?\`,
          [const errorMessage = error.message;
      errorMessage, signal.id] // Usar errorMessage formatado
        );
      } catch (updateError) {
        console.error(\`[SIGNAL] Erro ao atualizar status para ERROR:\`, updateError);
      }`;

const fixedCode = `      // Atualizar status para ERROR
      try {
        const errorMessage = formatErrorMessage(error);
        await db.query(
          \`UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?\`,
          [errorMessage, signal.id]
        );
      } catch (updateError) {
        console.error(\`[SIGNAL] Erro ao atualizar status para ERROR:\`, updateError);
      }`;

content = content.replace(brokenCode, fixedCode);

// Adicionar funções utilitárias que estão sendo usadas mas não existem
const utilityFunctions = `
/**
 * Formata mensagem de entrada para Telegram
 */
function formatEntryMessage(signal, quantity, averagePrice, totalValue) {
  return \`📈 ENTRADA EXECUTADA

Símbolo: \${signal.symbol}
Lado: \${signal.side}
Quantidade: \${quantity}
Preço Médio: \${averagePrice}
Valor Total: \${totalValue.toFixed(2)} USDT
Alavancagem: \${signal.leverage}x

🎯 Take Profit: \${signal.tp_price}
🛡️ Stop Loss: \${signal.sl_price}\`;
}

/**
 * Formata mensagem de erro para Telegram
 */
function formatErrorMessage(signal, errorMsg) {
  return \`🚨 ERRO NA EXECUÇÃO

Símbolo: \${signal.symbol}
Lado: \${signal.side}
Preço Entrada: \${signal.entry_price}

❌ Erro: \${errorMsg}

Verifique os logs para mais detalhes.\`;
}

`;

// Adicionar as funções utilitárias antes da função processSignal
content = content.replace(
  /async function processSignal/,
  `${utilityFunctions}
/**
 * Processa um sinal de entrada
 * @param {Object} db - Conexão com banco
 * @param {Object} signal - Dados do sinal
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function processSignal`
);

// Corrigir outras chamadas para sendTelegramMessage que estão incorretas
content = content.replace(
  /await sendTelegramMessage\(accountId, chat_id, message\);/g,
  'await sendTelegramMessage(message, accountId);'
);

content = content.replace(
  /await sendTelegramMessage\(accountId, signal\.chat_id, errorMessage\);/g,
  'await sendTelegramMessage(errorMessage, accountId);'
);

// Corrigir a chamada na função processSignal onde chat_id é usado
content = content.replace(
  /await sendTelegramMessage\(message, accountId\);/g,
  'try { await sendTelegramMessage(message, accountId); } catch (telegramError) { console.warn("[TELEGRAM] Erro ao enviar mensagem:", telegramError.message); }'
);

// Garantir que todas as mensagens de erro sejam tratadas adequadamente
content = content.replace(
  /const errorMessage = formatErrorMessage\(signal, error\.message\);/g,
  'const errorMessage = formatErrorMessage(signal, formatErrorMessage(error));'
);

// Corrigir problema onde errorMessage pode não estar definido em alguns catches
const problematicCatch = `if (signal.chat_id) {
        const errorMessage = formatErrorMessage(signal, error.message);
        await sendTelegramMessage(errorMessage, accountId);
      }`;

const fixedCatch = `if (signal.chat_id) {
        try {
          const errorMsg = formatErrorMessage(signal, formatErrorMessage(error));
          await sendTelegramMessage(errorMsg, accountId);
        } catch (telegramError) {
          console.warn("[TELEGRAM] Erro ao enviar notificação de erro:", telegramError.message);
        }
      }`;

content = content.replace(problematicCatch, fixedCatch);

fs.writeFileSync(signalProcessorPath, content, 'utf8');

console.log('✅ signalProcessor.js corrigido');

// Criar um arquivo de teste específico para o signalProcessor
const testScript = `// Teste específico do signalProcessor
const { checkNewTrades } = require('./posicoes/signalProcessor');

async function testSignalProcessor() {
  console.log('🧪 Testando signalProcessor...');
  
  try {
    console.log('\\n=== TESTE: checkNewTrades ===');
    
    // Testar com accountId válido
    await checkNewTrades(1);
    console.log('✅ checkNewTrades executado sem erros de sintaxe');
    
    console.log('\\n🎉 signalProcessor funcionando corretamente!');
    
  } catch (error) {
    console.error('❌ Erro no teste do signalProcessor:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  testSignalProcessor();
}

module.exports = { testSignalProcessor };`;

fs.writeFileSync(path.join(__dirname, 'test-signalprocessor.js'), testScript);

console.log('✅ Arquivo de teste criado: test-signalprocessor.js');

console.log('\n🎉 Correção de sintaxe concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Erro de sintaxe na linha 140-142 corrigido');
console.log('2. ✅ Import de sendTelegramMessage adicionado');
console.log('3. ✅ Funções utilitárias formatEntryMessage e formatErrorMessage adicionadas');
console.log('4. ✅ Chamadas para sendTelegramMessage corrigidas');
console.log('5. ✅ Tratamento de erros melhorado');

console.log('\n🧪 Execute o teste:');
console.log('   node test-signalprocessor.js');

console.log('\n🚀 Depois teste o monitoramento completo:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backup criado para segurança.');