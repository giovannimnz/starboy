const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function testConnection() {
    console.log('Iniciando teste de conexão com o banco de dados...');
    console.log(`Conectando a: ${process.env.DB_HOST}:${process.env.DB_PORT} (${process.env.DB_NAME})`);
    
    let connection;
    try {
        // Criar conexão
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });
        
        console.log('✅ Conexão estabelecida com sucesso!');
        
        // Testar uma consulta simples
        const [rows] = await connection.execute('SELECT 1 + 1 AS result');
        console.log('✅ Consulta de teste executada com sucesso!');
        console.log(`Resultado: ${rows[0].result}`);
        
        // Verificar tabelas existentes
        const [tables] = await connection.execute('SHOW TABLES');
        console.log('\n📋 Tabelas encontradas no banco de dados:');
        if (tables.length === 0) {
            console.log('  Nenhuma tabela encontrada.');
        } else {
            tables.forEach(table => {
                const tableName = Object.values(table)[0];
                console.log(`  - ${tableName}`);
            });
        }
        
        return true;
    } catch (error) {
        console.error('❌ Erro ao conectar ao banco de dados:');
        console.error(error.message);
        return false;
    } finally {
        if (connection) {
            console.log('Fechando conexão...');
            await connection.end();
        }
    }
}

// Executar o teste
testConnection()
    .then(success => {
        if (success) {
            console.log('\n🚀 Teste de conexão concluído com sucesso!');
        } else {
            console.log('\n⚠️ Teste de conexão falhou.');
        }
    })
    .catch(err => {
        console.error('Erro não tratado durante o teste:', err);
    });