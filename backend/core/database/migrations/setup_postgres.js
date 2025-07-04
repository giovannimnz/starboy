const { Client } = require('pg');
const fs = require('fs').promises;
const path = require('path');

// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config({ path: path.resolve(__dirname, '../../../config/.env') });

/**
 * Função principal para criar e configurar o banco de dados PostgreSQL.
 */
async function setupDatabase() {
    console.log('Iniciando a configuração do banco de dados PostgreSQL...');

    const dbConfig = {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT, 10),
    };
    const dbName = process.env.DB_NAME || 'starboy_dev';

    // --- Passo 1: Conectar ao servidor PostgreSQL (sem especificar o DB) para criar o banco de dados ---
    const client = new Client({ ...dbConfig, database: 'postgres' }); // Conecta ao DB 'postgres' padrão

    try {
        await client.connect();
        console.log('Conexão com o servidor PostgreSQL estabelecida com sucesso.');

        // Verifica se o banco de dados já existe
        const res = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);

        if (res.rowCount === 0) {
            console.log(`Banco de dados "${dbName}" não encontrado. Criando...`);
            await client.query(`CREATE DATABASE "${dbName}"`);
            console.log(`✅ Banco de dados "${dbName}" criado.`);
        } else {
            console.log(`Banco de dados "${dbName}" já existe.`);
        }
    } catch (error) {
        console.error(`❌ Erro durante a criação/verificação do banco de dados: ${error.message}`);
        throw error;
    } finally {
        await client.end();
        console.log('Conexão inicial com o servidor PostgreSQL encerrada.');
    }

    // --- Passo 2: Conectar ao banco de dados específico e executar o script SQL ---
    const appClient = new Client({ ...dbConfig, database: dbName });
    try {
        await appClient.connect();
        console.log(`\nConectado ao banco de dados "${dbName}" com sucesso.`);
        console.log('Lendo o script SQL "create_postgres_db.sql"...');

        // Lê o conteúdo do arquivo SQL
        const sqlScript = await fs.readFile(path.resolve(__dirname, 'create_postgres_db.sql'), 'utf8');

        console.log('Executando o script para criar/verificar tabelas, chaves e índices...');
        await appClient.query(sqlScript);

        console.log('\n🚀 Processo concluído! O banco de dados e todas as tabelas foram criados/verificados com sucesso.');

    } catch (error) {
        console.error(`❌ Erro durante a execução do script SQL no banco "${dbName}": ${error.message}`);
        throw error;
    } finally {
        await appClient.end();
        console.log(`Conexão com o banco "${dbName}" encerrada.`);
    }
}

// Executa a função principal
setupDatabase()
    .then(() => {
        console.log('\nScript finalizado com sucesso!');
        process.exit(0);
    })
    .catch(err => {
        console.error('\nFalha crítica na execução do script:', err.message);
        process.exit(1);
    });