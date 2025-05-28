module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['./tests/setup.js'],
  testTimeout: 30000, // 30 segundos de timeout para os testes
  verbose: true,
  // Opção para manter o Jest esperando após os testes
  // para ver logs detalhados: --detectOpenHandles
  detectOpenHandles: false
};