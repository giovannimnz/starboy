const fetch = require('isomorphic-fetch');
const { spawn } = require('child_process');
const path = require('path');

async function testSwagger() {
    console.log('🔍 Testando correção do Swagger...');
    
    const cwd = path.resolve(__dirname, 'backend/server');
    console.log(`📁 Diretório de trabalho: ${cwd}`);
    
    // Inicia o servidor
    const server = spawn('node', ['api.js'], { 
        cwd,
        stdio: 'pipe',
        env: { ...process.env, NODE_ENV: 'development' }
    });
    
    console.log('🚀 Iniciando servidor...');
    
    // Aguarda o servidor iniciar
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    try {
        console.log('🔄 Testando endpoints do Swagger...');
        
        // Testa endpoint de documentação JSON
        const jsonResponse = await fetch('http://0.0.0.0:8050/docs/json');
        console.log(`📄 /docs/json - Status: ${jsonResponse.status}`);
        
        if (!jsonResponse.ok) {
            const error = await jsonResponse.text();
            console.error('❌ Erro no endpoint JSON:', error);
        } else {
            const swaggerJson = await jsonResponse.json();
            console.log('✅ Swagger JSON carregado com sucesso');
            
            // Verifica se bearerAuth está definido
            if (swaggerJson.components && swaggerJson.components.securitySchemes && swaggerJson.components.securitySchemes.bearerAuth) {
                console.log('✅ bearerAuth está definido corretamente');
            } else {
                console.log('❌ bearerAuth não está definido');
            }
        }
        
        // Testa endpoint de UI
        const uiResponse = await fetch('http://0.0.0.0:8050/docs');
        console.log(`🎨 /docs - Status: ${uiResponse.status}`);
        
        if (!uiResponse.ok) {
            const error = await uiResponse.text();
            console.error('❌ Erro no endpoint UI:', error);
        } else {
            console.log('✅ Swagger UI carregado com sucesso');
        }
        
        // Testa endpoint de health check
        const healthResponse = await fetch('http://0.0.0.0:8050/api/health');
        console.log(`💚 /api/health - Status: ${healthResponse.status}`);
        
        if (!healthResponse.ok) {
            const error = await healthResponse.text();
            console.error('❌ Erro no health check:', error);
        } else {
            const health = await healthResponse.json();
            console.log('✅ Health check:', health);
        }
        
    } catch (error) {
        console.error('❌ Erro ao testar Swagger:', error.message);
    }
    
    // Finaliza o servidor
    server.kill();
    console.log('🛑 Servidor finalizado');
}

testSwagger().catch(console.error);
