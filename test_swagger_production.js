const path = require('path');
const fetch = require('isomorphic-fetch');

async function testSwaggerProduction() {
  console.log('🔍 Testando correção do Swagger em produção...');
  
  const baseUrl = 'http://137.131.190.161:8050'; // IP de produção
  
  try {
    console.log('🔄 Testando /docs/json...');
    const jsonResponse = await fetch(`${baseUrl}/docs/json`);
    console.log(`📄 Status: ${jsonResponse.status}`);
    
    if (jsonResponse.ok) {
      const jsonData = await jsonResponse.json();
      console.log('✅ Swagger JSON carregado com sucesso!');
      console.log(`📊 Versão API: ${jsonData.info?.version}`);
      console.log(`📊 Título: ${jsonData.info?.title}`);
      console.log(`📊 Rotas documentadas: ${Object.keys(jsonData.paths || {}).length}`);
      
      // Verifica se bearerAuth está definido
      if (jsonData.components?.securitySchemes?.bearerAuth) {
        console.log('✅ bearerAuth definido corretamente');
      } else {
        console.log('❌ bearerAuth não encontrado');
      }
      
    } else {
      const errorText = await jsonResponse.text();
      console.error('❌ Erro no endpoint JSON:', errorText);
    }
    
    console.log('\n🔄 Testando /docs...');
    const docsResponse = await fetch(`${baseUrl}/docs`);
    console.log(`🎨 Status: ${docsResponse.status}`);
    
    if (docsResponse.ok) {
      console.log('✅ Swagger UI carregado com sucesso!');
    } else {
      const errorText = await docsResponse.text();
      console.error('❌ Erro no UI:', errorText);
    }
    
    console.log('\n🔄 Testando /api/health...');
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    console.log(`💚 Status: ${healthResponse.status}`);
    
    if (healthResponse.ok) {
      const healthData = await healthResponse.json();
      console.log('✅ Health check:', healthData);
    } else {
      const errorText = await healthResponse.text();
      console.error('❌ Erro no health check:', errorText);
    }
    
  } catch (error) {
    console.error('❌ Erro ao testar produção:', error.message);
    console.error('💡 Verifique se o servidor está rodando em produção');
  }
}

// Executa o teste
testSwaggerProduction().then(() => {
  console.log('\n🎉 Teste concluído!');
}).catch(error => {
  console.error('❌ Erro no teste:', error);
});
