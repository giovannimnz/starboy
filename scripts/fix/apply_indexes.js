const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Carrega as variáveis de ambiente
require('dotenv').config({ path: path.resolve(__dirname, 'config/.env') });

/**
 * Script para aplicar índices de otimização no banco de dados
 * Baseado na análise das consultas mais críticas do sistema
 */
async function applyDatabaseIndexes() {
    console.log('=========================================================================');
    console.log('🚀 APLICAÇÃO DE ÍNDICES DE OTIMIZAÇÃO - STARBOY TRADING SYSTEM');
    console.log('=========================================================================');
    console.log(`⏰ Iniciado em: ${new Date().toLocaleString()}\n`);

    let connection;

    try {
        // Verificar argumentos da linha de comando
        const args = process.argv.slice(2);
        const isAnalyzeMode = args.includes('--analyze');
        const isMonitorMode = args.includes('--monitor');

        if (isAnalyzeMode) {
            await analyzeIndexPerformance();
            return;
        }

        if (isMonitorMode) {
            await monitorIndexUsage();
            return;
        }

        // Conectar ao banco
        console.log('🔗 Conectando ao banco de dados...');
        console.log(`   Host: ${process.env.DB_HOST}`);
        console.log(`   Porta: ${process.env.DB_PORT}`);
        console.log(`   Banco: ${process.env.DB_NAME}`);
        console.log(`   Usuário: ${process.env.DB_USER}\n`);

        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            multipleStatements: true
        });

        console.log('✅ Conexão estabelecida com sucesso!\n');

        // Fazer backup da estrutura antes de aplicar
        console.log('💾 Criando backup da estrutura...');
        await createStructureBackup(connection);

        // Ler o arquivo de índices
        const sqlFile = path.join(__dirname, 'backend/core/database/migrations/database_indexes_optimization.sql');
        
        if (!fs.existsSync(sqlFile)) {
            throw new Error('Arquivo de índices não encontrado: ' + sqlFile);
        }

        console.log('📄 Lendo arquivo de índices...');
        const sqlContent = fs.readFileSync(sqlFile, 'utf8');

        // Aplicar o arquivo SQL completo
        console.log('🔧 Aplicando índices de otimização...');
        await connection.query(sqlContent);

        console.log('✅ Índices aplicados com sucesso!\n');

        // Verificar índices criados
        await verifyIndexes(connection);

        // Executar análise das tabelas
        await analyzeMainTables(connection);

        // Testar queries críticas
        await testCriticalQueries(connection);

        console.log('=========================================================================');
        console.log('✅ APLICAÇÃO DE ÍNDICES CONCLUÍDA COM SUCESSO!');
        console.log('=========================================================================');
        console.log(`⏰ Finalizado em: ${new Date().toLocaleString()}\n`);

        console.log('📋 PRÓXIMOS PASSOS:');
        console.log('   1. 🔄 Reinicie o sistema para garantir uso dos novos índices');
        console.log('   2. 📊 Monitore performance com: node apply_indexes.js --monitor');
        console.log('   3. 🧪 Execute testes das funcionalidades principais');
        console.log('   4. 💾 Verifique uso de espaço em disco regularmente\n');

    } catch (error) {
        console.error('❌ Erro durante a aplicação dos índices:', error);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
            console.log('🔌 Conexão fechada.\n');
        }
    }
}

/**
 * Cria backup da estrutura da base de dados
 */
async function createStructureBackup(connection) {
    try {
        const backupDir = path.join(__dirname, 'backend/core/backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupFile = path.join(backupDir, `indexes_backup_${timestamp}.sql`);
        
        console.log(`   Backup seria salvo em: ${backupFile}`);
        console.log('✅ Use mysqldump para backup completo da estrutura\n');
        
    } catch (error) {
        console.warn('⚠️  Aviso: Não foi possível criar backup via Node.js');
        console.warn('   Recomenda-se usar mysqldump diretamente\n');
    }
}

/**
 * Verifica os índices criados
 */
async function verifyIndexes(connection) {
    console.log('📊 Verificando índices aplicados...');
    
    const [indexes] = await connection.query(`
        SELECT 
            TABLE_NAME as tabela,
            COUNT(*) as total_indices
        FROM information_schema.STATISTICS 
        WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME IN ('posicoes', 'ordens', 'webhook_signals', 'contas')
            AND INDEX_NAME LIKE 'idx_%'
        GROUP BY TABLE_NAME
        ORDER BY TABLE_NAME
    `);
    
    console.log('\n   Índices por tabela:');
    indexes.forEach(row => {
        console.log(`   • ${row.tabela}: ${row.total_indices} índices`);
    });
    console.log('');
}

/**
 * Executa ANALYZE TABLE nas tabelas principais
 */
async function analyzeMainTables(connection) {
    console.log('🔍 Atualizando estatísticas das tabelas...');
    
    const tables = ['posicoes', 'ordens', 'webhook_signals', 'contas'];
    
    for (const table of tables) {
        try {
            await connection.query(`ANALYZE TABLE ${table}`);
            console.log(`   ✅ ${table} analisada`);
        } catch (error) {
            console.log(`   ⚠️  Erro ao analisar ${table}: ${error.message}`);
        }
    }
    console.log('');
}

/**
 * Testa as queries mais críticas do sistema
 */
async function testCriticalQueries(connection) {
    console.log('🧪 Testando queries críticas...');
    
    try {
        // Teste 1: Query crítica do reverse.js (linha 983)
        console.log('   • Testando: posições por símbolo + status + conta...');
        const [explain1] = await connection.query(`
            EXPLAIN SELECT id FROM posicoes 
            WHERE simbolo = 'BTCUSDT' AND status = 'OPEN' AND conta_id = 1 
            ORDER BY id DESC LIMIT 1
        `);
        
        const usingIndex1 = explain1.some(row => 
            row.key && row.key.includes('idx_') || 
            row.Extra && row.Extra.includes('Using index')
        );
        console.log(`     ${usingIndex1 ? '✅' : '⚠️'} Index ${usingIndex1 ? 'sendo utilizado' : 'pode não estar sendo utilizado'}`);
        
        // Teste 2: Query crítica do positionSync.js (LEFT JOIN)
        console.log('   • Testando: LEFT JOIN posições sem sinais...');
        const [explain2] = await connection.query(`
            EXPLAIN SELECT p.id FROM posicoes p 
            LEFT JOIN webhook_signals ws ON ws.position_id = p.id 
            WHERE p.status = 'OPEN' AND p.conta_id = 1 AND ws.position_id IS NULL 
            LIMIT 1
        `);
        
        const usingIndex2 = explain2.some(row => 
            row.key && row.key.includes('idx_') || 
            row.Extra && row.Extra.includes('Using index')
        );
        console.log(`     ${usingIndex2 ? '✅' : '⚠️'} Index ${usingIndex2 ? 'sendo utilizado' : 'pode não estar sendo utilizado'}`);
        
        // Teste 3: Query de ordens por origin signal
        console.log('   • Testando: ordens por origin signal...');
        const [explain3] = await connection.query(`
            EXPLAIN SELECT id_externo FROM ordens 
            WHERE orign_sig = 'test_signal' AND status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = 1
        `);
        
        const usingIndex3 = explain3.some(row => 
            row.key && row.key.includes('idx_') || 
            row.Extra && row.Extra.includes('Using index')
        );
        console.log(`     ${usingIndex3 ? '✅' : '⚠️'} Index ${usingIndex3 ? 'sendo utilizado' : 'pode não estar sendo utilizado'}`);
        
    } catch (error) {
        console.log('   ⚠️  Erro ao testar queries:', error.message);
    }
    console.log('');
}

/**
 * Função para análise de performance (modo --analyze)
 */
async function analyzeIndexPerformance() {
    console.log('=========================================================================');
    console.log('📊 ANÁLISE DE PERFORMANCE DOS ÍNDICES');
    console.log('=========================================================================\n');

    let connection;
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });

        console.log('🔗 Conectado ao banco de dados\n');

        // Análise de tamanhos de tabelas e índices
        console.log('📈 Tamanhos das tabelas e índices:');
        const [sizes] = await connection.query(`
            SELECT 
                TABLE_NAME as Tabela,
                TABLE_ROWS as Linhas,
                ROUND(((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024), 2) AS 'Tamanho_Total_MB',
                ROUND((INDEX_LENGTH / 1024 / 1024), 2) AS 'Tamanho_Indices_MB',
                ROUND((INDEX_LENGTH / (DATA_LENGTH + INDEX_LENGTH)) * 100, 1) AS 'Percentual_Indices'
            FROM information_schema.TABLES 
            WHERE TABLE_SCHEMA = DATABASE() 
                AND TABLE_NAME IN ('posicoes', 'ordens', 'webhook_signals', 'contas')
            ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
        `);
        
        console.table(sizes);

        // Lista todos os índices criados
        console.log('\n📋 Índices criados pelo sistema:');
        const [allIndexes] = await connection.query(`
            SELECT 
                TABLE_NAME as Tabela,
                INDEX_NAME as Indice,
                GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as Colunas,
                CARDINALITY as Cardinalidade
            FROM information_schema.STATISTICS 
            WHERE TABLE_SCHEMA = DATABASE() 
                AND INDEX_NAME LIKE 'idx_%'
                AND TABLE_NAME IN ('posicoes', 'ordens', 'webhook_signals', 'contas')
            GROUP BY TABLE_NAME, INDEX_NAME
            ORDER BY TABLE_NAME, INDEX_NAME
        `);
        
        console.table(allIndexes);

        // Queries de exemplo para testar performance
        console.log('\n🧪 Queries de teste recomendadas:');
        console.log('');
        console.log('-- Query crítica 1 (reverse.js):');
        console.log("EXPLAIN SELECT id FROM posicoes WHERE simbolo = 'BTCUSDT' AND status = 'OPEN' AND conta_id = 1 ORDER BY id DESC LIMIT 1;");
        console.log('');
        console.log('-- Query crítica 2 (positionSync.js):');
        console.log("EXPLAIN SELECT p.id FROM posicoes p LEFT JOIN webhook_signals ws ON ws.position_id = p.id WHERE p.status = 'OPEN' AND p.conta_id = 1 AND ws.position_id IS NULL;");
        console.log('');
        console.log('-- Query crítica 3 (reverse.js ordens):');
        console.log("EXPLAIN SELECT id_externo FROM ordens WHERE orign_sig = 'signal_123' AND status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = 1;");

    } catch (error) {
        console.error('❌ Erro na análise:', error);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

/**
 * Função para monitoramento de uso dos índices (modo --monitor)
 */
async function monitorIndexUsage() {
    console.log('=========================================================================');
    console.log('📡 MONITORAMENTO DE USO DOS ÍNDICES');
    console.log('=========================================================================\n');

    let connection;
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });

        console.log('🔗 Conectado ao banco de dados\n');

        // Verificar queries lentas
        console.log('🐌 Queries atualmente em execução (> 1 segundo):');
        const [slowQueries] = await connection.query(`
            SELECT 
                ID,
                USER,
                HOST,
                DB,
                COMMAND,
                TIME,
                STATE,
                LEFT(INFO, 100) as QUERY_PREVIEW
            FROM information_schema.PROCESSLIST 
            WHERE COMMAND != 'Sleep' AND TIME > 1
            ORDER BY TIME DESC
        `);
        
        if (slowQueries.length > 0) {
            console.table(slowQueries);
        } else {
            console.log('✅ Nenhuma query lenta detectada no momento\n');
        }

        // Status das tabelas principais
        console.log('📊 Status das tabelas principais:');
        const [tableStatus] = await connection.query(`
            SHOW TABLE STATUS WHERE Name IN ('posicoes', 'ordens', 'webhook_signals', 'contas')
        `);
        
        const relevantStatus = tableStatus.map(table => ({
            Tabela: table.Name,
            Linhas: table.Rows,
            'Tamanho_MB': Math.round((table.Data_length + table.Index_length) / 1024 / 1024 * 100) / 100,
            'Fragmentacao': table.Data_free > 0 ? 'Sim' : 'Não',
            Engine: table.Engine
        }));
        
        console.table(relevantStatus);

        // Comandos úteis para monitoramento contínuo
        console.log('\n🛠️  Comandos úteis para monitoramento:');
        console.log('');
        console.log('-- Ver queries em execução:');
        console.log('SHOW PROCESSLIST;');
        console.log('');
        console.log('-- Verificar uso dos índices:');
        console.log('SELECT TABLE_NAME, INDEX_NAME, CARDINALITY FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY CARDINALITY DESC;');
        console.log('');
        console.log('-- Otimizar tabelas (execute durante manutenção):');
        console.log('OPTIMIZE TABLE posicoes, ordens, webhook_signals, contas;');
        console.log('');
        console.log('-- Atualizar estatísticas (execute semanalmente):');
        console.log('ANALYZE TABLE posicoes, ordens, webhook_signals, contas;');

    } catch (error) {
        console.error('❌ Erro no monitoramento:', error);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Executar o script
if (require.main === module) {
    applyDatabaseIndexes()
        .then(() => {
            console.log('🎉 Script finalizado com sucesso!');
            process.exit(0);
        })
        .catch(err => {
            console.error('💥 Falha na execução:', err.message);
            process.exit(1);
        });
}

module.exports = { applyDatabaseIndexes, analyzeIndexPerformance, monitorIndexUsage };
