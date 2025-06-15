const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function corrigirWebSocket() {
  console.log('=== INICIANDO CORREÇÃO DO PACOTE WEBSOCKET ===');
  
  try {
    console.log('1. Verificando instalação atual do pacote ws...');
    
    // Verificar a versão atual do ws
    const packageLockPath = path.join(__dirname, '..', 'package-lock.json');
    let wsVersion = '';
    
    if (fs.existsSync(packageLockPath)) {
      const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
      if (packageLock.dependencies && packageLock.dependencies.ws) {
        wsVersion = packageLock.dependencies.ws.version;
        console.log(`Versão atual do ws: ${wsVersion}`);
      }
    }
    
    console.log('2. Desinstalando pacote ws atual...');
    execSync('npm uninstall ws', { stdio: 'inherit' });
    
    console.log('3. Limpando cache do npm...');
    execSync('npm cache clean --force', { stdio: 'inherit' });
    
    console.log('4. Instalando ws versão 8.5.0 (versão estável compatível)...');
    execSync('npm install ws@8.5.0', { stdio: 'inherit' });
    
    console.log('\n✅ Pacote WebSocket corrigido com sucesso!');
    console.log('Por favor, reinicie o sistema usando o comando:');
    console.log('node utils/iniciarOtimizado.js');
    
  } catch (error) {
    console.error('\n❌ Erro durante a correção:', error.message);
    console.log('\nCaso o erro persista, use a alternativa sem WebSocket:');
    console.log('node utils/iniciarSemWebSocket.js');
  }
}

corrigirWebSocket();