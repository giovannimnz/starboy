-- =========================================================================
-- SCRIPT DE CORREÇÃO DOS TRIGGERS - POSTGRESQL
-- =========================================================================
-- Sistema: Starboy Trading System
-- Objetivo: Corrigir a função de trigger que estava causando erro ao tentar
--           acessar campo 'atualizado_em' em tabelas que não possuem esse campo.
-- =========================================================================

-- Dropa e recria a função de trigger corrigida
DROP FUNCTION IF EXISTS update_timestamp_column() CASCADE;

CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
    -- Para a tabela 'users' que usa 'atualizado_em'
    IF TG_TABLE_NAME = 'users' THEN
        NEW.atualizado_em = CURRENT_TIMESTAMP;
    END IF;
    -- Para a tabela 'contas' que usa 'ultima_atualizacao'
    IF TG_TABLE_NAME = 'contas' THEN
        NEW.ultima_atualizacao = CURRENT_TIMESTAMP;
    END IF;
    -- Para outras tabelas que possam usar nomes diferentes
    IF TG_TABLE_NAME = 'corretoras' THEN
        NEW.ultima_atualizacao = CURRENT_TIMESTAMP;
    END IF;
    IF TG_TABLE_NAME = 'exchange_symbols' THEN
        NEW.updated_at = CURRENT_TIMESTAMP;
    END IF;
    IF TG_TABLE_NAME = 'posicoes' THEN
        NEW.data_hora_ultima_atualizacao = CURRENT_TIMESTAMP;
        NEW.last_update = CURRENT_TIMESTAMP;
    END IF;
     IF TG_TABLE_NAME = 'webhook_signals' THEN
        NEW.updated_at = CURRENT_TIMESTAMP;
    END IF;
     IF TG_TABLE_NAME = 'ordens' THEN
        NEW.last_update = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Recria todos os triggers
CREATE TRIGGER set_timestamp_users
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_corretoras
BEFORE UPDATE ON corretoras
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_contas
BEFORE UPDATE ON contas
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_exchange_symbols
BEFORE UPDATE ON exchange_symbols
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_posicoes
BEFORE UPDATE ON posicoes
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_webhook_signals
BEFORE UPDATE ON webhook_signals
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_ordens
BEFORE UPDATE ON ordens
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

-- Confirma as alterações
SELECT 'Triggers corrigidos com sucesso!' as status;
