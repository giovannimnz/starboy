# Testes do Sistema de Indicadores

Este diretório contém os testes organizados do sistema de indicadores do projeto Starboy Postgres.

## Estrutura

```
backend/tests/indicators/
├── integration/           # Testes de integração
│   ├── test_indicators_integration.py
│   └── __init__.py
├── unit/                 # Testes unitários
│   ├── test_exchange_bracket_updater.py
│   ├── test_divap_analyzer.py
│   └── __init__.py
├── fix/                  # Scripts de correção
│   ├── fix_indicators_system.py
│   └── __init__.py
├── run_indicator_tests.py  # Script principal de execução
└── __init__.py
```

## Como executar

### Executar todos os testes
```bash
cd backend/tests
python run_indicator_tests.py
```

### Executar correções do sistema
```bash
cd backend/tests/indicators/fix
python fix_indicators_system.py
```

### Executar teste de integração específico
```bash
cd backend/tests/indicators/integration
python test_indicators_integration.py
```

### Executar testes unitários específicos
```bash
cd backend/tests/indicators/unit
python test_exchange_bracket_updater.py
python test_divap_analyzer.py
```

## Tipos de Teste

### Testes de Integração
- **test_indicators_integration.py**: Testa a integração completa do sistema
  - Carregamento de configurações
  - Imports de todos os módulos
  - Conexões com banco de dados
  - Importação dos módulos principais (divap.py, divap_backtest.py)

### Testes Unitários
- **test_exchange_bracket_updater.py**: Testa funções do atualizador de brackets
  - Conexão com banco de dados
  - Credenciais da Binance
  - Atualização de brackets de leverage

- **test_divap_analyzer.py**: Testa a classe DIVAPAnalyzer
  - Conexões com banco e exchange
  - Análise de sinais DIVAP
  - Verificação de padrões
  - Salvamento de resultados

### Scripts de Correção
- **fix_indicators_system.py**: Script de diagnóstico e correção
  - Verifica caminhos de importação
  - Valida configurações do .env
  - Testa estrutura do banco de dados
  - Verifica permissões de arquivos

## Dependências

Os testes requerem:
- Python 3.12+
- Conexão com banco PostgreSQL
- Credenciais válidas da Binance (para alguns testes)
- Arquivo .env configurado
- Módulos do sistema de indicadores funcionais

## Resultados

### Status de Execução
- ✅ **OK**: Teste passou
- ❌ **FALHOU**: Teste falhou
- ⚠️ **AVISO**: Teste passou com avisos

### Cobertura Atual
- [x] Imports dos módulos utilitários
- [x] Conexões de banco de dados
- [x] Configurações de ambiente
- [x] Estrutura de arquivos
- [x] Funcionalidades básicas do DIVAPAnalyzer
- [x] Funcionalidades do exchange_bracket_updater

## Melhorias Futuras

1. **Cobertura de Testes**
   - Adicionar testes para divap.py
   - Testes para exchange_info_updater.py
   - Testes para boolean_validator.py

2. **Automação**
   - Integração com CI/CD
   - Testes automatizados em diferentes ambientes
   - Relatórios de cobertura de código

3. **Mocks e Fixtures**
   - Dados de teste padronizados
   - Mocks para APIs externas
   - Fixtures para banco de dados

## Troubleshooting

### Problemas Comuns

1. **Erro de import**: Verifique se os módulos estão no local correto
2. **Conexão com banco**: Verifique as configurações no .env
3. **Credenciais Binance**: Confirme se as chaves estão válidas
4. **Arquivos vazios**: Execute o script de correção

### Logs

Os testes geram logs detalhados que ajudam na identificação de problemas:
- Timestamps de execução
- Status de cada teste
- Detalhes de erros e falhas
- Estatísticas finais
