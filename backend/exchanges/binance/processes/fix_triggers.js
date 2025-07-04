/**
 * Script para corrigir os triggers do banco de dados
 * Corrige o erro: "registro 'new' não tem campo 'atualizado_em'"
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');

async function fixTriggers() {
    console.log('🔧 === CORREÇÃO DOS TRIGGERS DO BANCO ===');
    
    try {
        const db = await getDatabaseInstance();
        
        console.log('📊 Conectado ao banco de dados');
        
        // Dropa a função atual e recria corrigida
        console.log('🗑️ Removendo função de trigger atual...');
        await db.query('DROP FUNCTION IF EXISTS update_timestamp_column() CASCADE');
        
        console.log('✅ Função removida com sucesso');
        
        // Cria a função corrigida
        console.log('🔨 Criando função corrigida...');
        await db.query(`
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
        `);
        
        console.log('✅ Função criada com sucesso');
        
        // Recria todos os triggers
        console.log('🔄 Recriando triggers...');
        
        const triggers = [
            'CREATE TRIGGER set_timestamp_users BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_timestamp_column()',
            'CREATE TRIGGER set_timestamp_corretoras BEFORE UPDATE ON corretoras FOR EACH ROW EXECUTE FUNCTION update_timestamp_column()',
            'CREATE TRIGGER set_timestamp_contas BEFORE UPDATE ON contas FOR EACH ROW EXECUTE FUNCTION update_timestamp_column()',
            'CREATE TRIGGER set_timestamp_exchange_symbols BEFORE UPDATE ON exchange_symbols FOR EACH ROW EXECUTE FUNCTION update_timestamp_column()',
            'CREATE TRIGGER set_timestamp_posicoes BEFORE UPDATE ON posicoes FOR EACH ROW EXECUTE FUNCTION update_timestamp_column()',
            'CREATE TRIGGER set_timestamp_webhook_signals BEFORE UPDATE ON webhook_signals FOR EACH ROW EXECUTE FUNCTION update_timestamp_column()',
            'CREATE TRIGGER set_timestamp_ordens BEFORE UPDATE ON ordens FOR EACH ROW EXECUTE FUNCTION update_timestamp_column()'
        ];
        
        for (const trigger of triggers) {
            await db.query(trigger);
        }
        
        console.log('✅ Todos os triggers foram recriados com sucesso');
        
        // Testar um update simples para verificar se o trigger está funcionando
        console.log('🧪 Testando trigger na tabela contas...');
        await db.query('UPDATE contas SET saldo_spot = saldo_spot WHERE id = 5');
        console.log('✅ Teste do trigger executado com sucesso');
        
        console.log('🎉 Correção dos triggers concluída com sucesso!');
        
    } catch (error) {
        console.error('❌ Erro durante correção dos triggers:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Executar correção
fixTriggers();
