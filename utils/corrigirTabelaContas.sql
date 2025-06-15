-- Adicionar colunas que estão faltando na tabela contas
ALTER TABLE contas 
ADD COLUMN IF NOT EXISTS nome VARCHAR(100) DEFAULT 'Conta Principal',
ADD COLUMN IF NOT EXISTS descricao VARCHAR(255) DEFAULT 'Conta de trading',
ADD COLUMN IF NOT EXISTS ws_api_key VARCHAR(255),
ADD COLUMN IF NOT EXISTS ws_api_secret TEXT,
ADD COLUMN IF NOT EXISTS api_url VARCHAR(255),
ADD COLUMN IF NOT EXISTS ws_url VARCHAR(255),
ADD COLUMN IF NOT EXISTS ws_api_url VARCHAR(255),
ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50),
ADD COLUMN IF NOT EXISTS max_posicoes INT DEFAULT 10,
ADD COLUMN IF NOT EXISTS celular VARCHAR(20),
ADD COLUMN IF NOT EXISTS telegram_bot_token VARCHAR(255),
ADD COLUMN IF NOT EXISTS telegram_bot_token_controller VARCHAR(255);

-- Atualizar conta existente com os dados corretos
UPDATE contas SET 
  nome = 'Conta Principal',
  descricao = 'Conta de trading binance produção',
  ws_api_key = api_key,
  ws_api_secret = api_secret,
  api_url = 'https://fapi.binance.com/fapi',
  ws_url = 'wss://fstream.binance.com',
  ws_api_url = 'wss://ws-fapi.binance.com/ws-fapi/v1'
WHERE id = 1;