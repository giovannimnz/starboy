const fs = require('fs');
const path = require('path');

const files = [
  'backend/exchanges/binance/api/rest.js',
  'backend/exchanges/binance/api/websocket.js',
  'backend/exchanges/binance/services/accountHandlers.js',
  'backend/exchanges/binance/services/cleanup.js',
  'backend/exchanges/binance/services/enhancedMonitoring.js',
  'backend/exchanges/binance/services/limitMakerEntry.js',
  'backend/exchanges/binance/services/monitoramento.js',
  'backend/exchanges/binance/services/orderHandlers.js',
  'backend/exchanges/binance/services/positionHistory.js',
  'backend/exchanges/binance/services/positionSync.js',
  'backend/exchanges/binance/services/priceMonitoring.js',
  'backend/exchanges/binance/services/signalProcessor.js',
  'backend/exchanges/binance/services/signalTimeout.js',
  'backend/exchanges/binance/services/telegramBot.js',
  'backend/exchanges/binance/services/trailingStopLoss.js'
];

const replacements = [
  // Database connections
  [/require\(['"]\.\.\/core\/database\/conexao['"]\)/g, "require('../../../core/database/conexao')"],
  [/require\(['"]\.\.\/\.\.\/core\/database\/conexao['"]\)/g, "require('../../../core/database/conexao')"],
  
  // API imports for services
  [/require\(['"]\.\.\/exchanges\/binance\/api\/rest['"]\)/g, "require('../api/rest')"],
  [/require\(['"]\.\.\/exchanges\/binance\/api\/websocket['"]\)/g, "require('../api/websocket')"],
  
  // API imports for api files
  [/require\(['"]\.\.\/exchanges\/binance\/api\/rest['"]\)/g, "require('./rest')"],
];

files.forEach(filePath => {
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    
    replacements.forEach(([pattern, replacement]) => {
      const oldContent = content;
      content = content.replace(pattern, replacement);
      if (oldContent !== content) {
        modified = true;
      }
    });
    
    if (modified) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`✅ Corrigido: ${filePath}`);
    }
  }
});

console.log('🎉 Correção manual concluída!');