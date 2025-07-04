const { spawn } = require('child_process');
const path = require('path');

async function testSwaggerEndpoint() {
    console.log('🔍 Testando endpoint do Swagger...');
    
    // Inicia o servidor em background
    const server = spawn('node', ['api.js'], { 
        cwd: path.resolve(__dirname, 'backend/server'),
        stdio: 'pipe',
        env: { ...process.env, NODE_ENV: 'development' }
    });
    
    let serverOutput = '';
    server.stdout.on('data', (data) => {
        serverOutput += data.toString();
        console.log('📟 Server:', data.toString().trim());
    });
    
    server.stderr.on('data', (data) => {
        console.error('❌ Server Error:', data.toString().trim());
    });
    
    // Aguarda o servidor iniciar
    console.log('⏳ Aguardando servidor iniciar...');
    await new Promise(resolve => setTimeout(resolve, 8000));
    
    try {
        // Testa com curl
        const { exec } = require('child_process');
        
        console.log('🔄 Testando /docs/json...');
        exec('curl -s -o /dev/null -w "%{http_code}" http://0.0.0.0:8050/docs/json', (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Erro no curl:', error);
            } else {
                console.log(`📄 Status /docs/json: ${stdout}`);
            }
        });
        
        console.log('🔄 Testando /docs...');
        exec('curl -s -o /dev/null -w "%{http_code}" http://0.0.0.0:8050/docs', (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Erro no curl:', error);
            } else {
                console.log(`🎨 Status /docs: ${stdout}`);
            }
        });
        
        console.log('🔄 Testando /api/health...');
        exec('curl -s -o /dev/null -w "%{http_code}" http://0.0.0.0:8050/api/health', (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Erro no curl:', error);
            } else {
                console.log(`💚 Status /api/health: ${stdout}`);
            }
        });
        
        // Aguarda os testes
        setTimeout(() => {
            console.log('🛑 Finalizando servidor...');
            server.kill();
            console.log('✅ Teste concluído!');
        }, 5000);
        
    } catch (error) {
        console.error('❌ Erro ao testar:', error);
        server.kill();
    }
}

testSwaggerEndpoint().catch(console.error);
