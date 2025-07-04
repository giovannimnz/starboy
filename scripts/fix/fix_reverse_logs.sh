#!/bin/bash

# Script para substituir todos os console.log por reverseLog no arquivo reverse.js
FILE_PATH="c:/Users/muniz/Documents/GitHub/starboy_dev/backend/exchanges/binance/strategies/reverse.js"

# Fazer backup do arquivo original
cp "$FILE_PATH" "$FILE_PATH.backup.$(date +%Y%m%d_%H%M%S)"

# Substituir console.log por reverseLog (exceto os comentados)
sed -i 's/console\.log(/reverseLog(/g' "$FILE_PATH"

# Substituir console.error por reverseError
sed -i 's/console\.error(/reverseError(/g' "$FILE_PATH"

# Substituir console.warn por reverseWarn
sed -i 's/console\.warn(/reverseWarn(/g' "$FILE_PATH"

# Voltar a comentar logs de preços que devem ser suprimidos
sed -i 's/reverseLog(`\[LIMIT_ENTRY_DEPTH_WS\]/priceWSLog(`[LIMIT_ENTRY_DEPTH_WS]/g' "$FILE_PATH"

echo "Substituições concluídas no arquivo reverse.js"
echo "Backup criado em: $FILE_PATH.backup.$(date +%Y%m%d_%H%M%S)"
