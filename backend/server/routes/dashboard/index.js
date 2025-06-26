const { getDatabaseInstance } = require('../../../core/database/conexao');
// Importe a função que consulta saldo na corretora (ajuste o caminho se necessário)
const { getFuturesAccountBalanceDetails, getSpotAccountBalanceDetails } = require('../../../exchanges/binance/api/rest');

async function dashboardRoutes(fastify, options) {
  // 1. Selecionar conta (detalhes completos)
  fastify.get('/dashboard/account/:id', {
    schema: {
      description: 'Retorna os detalhes completos de uma conta pelo ID.',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    try {
      const [rows] = await db.query(`
        SELECT id, nome, descricao, id_corretora, api_key, api_secret, ws_api_key, ws_api_secret, telegram_chat_id, ativa, max_posicoes, saldo_base_calculo, saldo, data_criacao, ultima_atualizacao, celular, telegram_bot_token, telegram_bot_token_controller, saldo_cross_wallet, balance_change, last_event_reason, event_time, transaction_time, user_id
        FROM contas
        WHERE id = ?
        LIMIT 1
      `, [id]);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }
      reply.send({ success: true, data: rows[0] });
    } catch (error) {
      fastify.log.error('Erro ao buscar conta:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // 2. Saldo da conta (do banco)
  fastify.get('/dashboard/account/:id/saldo', {
    schema: {
      description: 'Retorna o saldo atual da conta (valor do banco de dados).',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    try {
      const [rows] = await db.query('SELECT saldo, saldo_base_calculo, ultima_atualizacao FROM contas WHERE id = ?', [id]);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }
      reply.send({ success: true, saldo: rows[0].saldo, saldo_base_calculo: rows[0].saldo_base_calculo, ultima_atualizacao: rows[0].ultima_atualizacao });
    } catch (error) {
      fastify.log.error('Erro ao buscar saldo:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // 3. Atualização manual de saldo (consulta na corretora)
  fastify.post('/dashboard/account/:id/atualizar-saldo', {
    schema: {
      description: 'Atualiza o saldo da conta consultando a corretora (manual).',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      // Consulta saldo na corretora e atualiza no banco
      const result = await getFuturesAccountBalanceDetails(Number(id));
      if (!result || !result.success) {
        return reply.status(500).send({ error: 'Erro ao consultar saldo na corretora', details: result?.error });
      }
      reply.send({ success: true, saldo: result.saldo, saldo_disponivel: result.saldo_disponivel, saldo_base_calculo: result.saldo_base_calculo, atualizado_em: result.timestamp });
    } catch (error) {
      fastify.log.error('Erro ao atualizar saldo:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // POST /dashboard/account/:id/selecionar - Seleciona a conta para o dashboard
  fastify.post('/dashboard/account/:id/selecionar', {
    schema: {
      description: 'Seleciona uma conta para exibir no dashboard.',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    try {
      const [rows] = await db.query('SELECT id, nome FROM contas WHERE id = ?', [id]);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }
      // Aqui você pode salvar a seleção em uma tabela, sessão, cache, etc.
      // Exemplo: reply.send apenas confirma a seleção
      reply.send({ success: true, message: `Conta ${rows[0].nome} selecionada para o dashboard.`, conta: rows[0] });
    } catch (error) {
      fastify.log.error('Erro ao selecionar conta:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  fastify.get('/dashboard/user/accounts', {
    schema: {
      description: 'Lista todas as contas do usuário logado ou uma conta específica pelo id.',
      tags: ['Dashboard'],
      querystring: {
        type: 'object',
        properties: {
          user_id: { type: 'integer', description: 'ID do usuário (obrigatório)' },
          id: { type: 'integer', description: 'ID da conta (opcional)' }
        },
        required: ['user_id']
      }
    }
  }, async (request, reply) => {
    const { user_id, id } = request.query;
    const db = await getDatabaseInstance();
    try {
      let query = `
        SELECT id, nome, descricao, id_corretora, ativa, saldo, saldo_base_calculo, ultima_atualizacao
        FROM contas
        WHERE user_id = ?
      `;
      const params = [user_id];
      if (id) {
        query += ' AND id = ?';
        params.push(id);
      }
      const [rows] = await db.query(query, params);
      reply.send({ success: true, data: rows, total: rows.length });
    } catch (error) {
      fastify.log.error('Erro ao buscar contas do usuário:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // GET /dashboard/account/:id/symbols?search=BTC
  fastify.get('/dashboard/account/chart/:id/symbols', {
    schema: {
      description: 'Lista todos os pares (symbols) disponíveis para a corretora da conta selecionada, com filtro de pesquisa.',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'ID da conta' }
        },
        required: ['id']
      },
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filtro de pesquisa (opcional)' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { search } = request.query;
    const db = await getDatabaseInstance();
    try {
      // Buscar exchange/corretora da conta
      const [contaRows] = await db.query('SELECT id_corretora FROM contas WHERE id = ?', [id]);
      if (!contaRows.length) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }
      // Buscar nome da corretora
      const idCorretora = contaRows[0].id_corretora;
      const [corretoraRows] = await db.query('SELECT corretora FROM corretoras WHERE id = ?', [idCorretora]);
      if (!corretoraRows.length) {
        return reply.status(404).send({ error: 'Corretora não encontrada' });
      }
      const exchange = corretoraRows[0].corretora.toLowerCase();

      // Query filtrando por quote_asset = 'USDT'
      let query = `
        SELECT id, exchange, symbol, status, pair, contract_type, base_asset, quote_asset, margin_asset, price_precision, quantity_precision, base_asset_precision, quote_precision, onboard_date, liquidation_fee, market_take_bound, updated_at
        FROM exchange_symbols
        WHERE exchange = ? AND quote_asset = 'USDT'
      `;
      const params = [exchange];
      if (search) {
        query += ` AND (symbol LIKE ? OR pair LIKE ? OR base_asset LIKE ? OR quote_asset LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      }
      query += ' ORDER BY symbol ASC';

      const [symbols] = await db.query(query, params);
      reply.send({ success: true, data: symbols, total: symbols.length });
    } catch (error) {
      fastify.log.error('Erro ao buscar symbols:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  fastify.post('/dashboard/account/chart/:id/symbol', {
    schema: {
      description: 'Registra o símbolo (par) selecionado pelo usuário para o gráfico.',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'ID da conta' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        required: ['symbol'],
        properties: {
          symbol: { type: 'string', description: 'Símbolo selecionado' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { symbol } = request.body;
    // Aqui você pode salvar a seleção em uma tabela, sessão, cache, etc.
    // Exemplo: apenas confirma a seleção
    reply.send({ success: true, message: `Símbolo ${symbol} selecionado para a conta ${id}.` });
  });

  // GET /dashboard/account/:id/saldo-futuros
  fastify.get('/dashboard/account/:id/saldo-futuros', async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    try {
      const [rows] = await db.query(
        `SELECT saldo_futuros, saldo_base_calculo_futuros, ultima_atualizacao FROM contas WHERE id = ?`, [id]
      );
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }
      reply.send({
        success: true,
        saldo_futuros: rows[0].saldo_futuros,
        saldo_base_calculo_futuros: rows[0].saldo_base_calculo_futuros,
        ultima_atualizacao: rows[0].ultima_atualizacao
      });
    } catch (error) {
      fastify.log.error('Erro ao buscar saldo futuros:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // GET /dashboard/account/:id/saldo-spot
  fastify.get('/dashboard/account/:id/saldo-spot', async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    try {
      const [rows] = await db.query(
        `SELECT saldo_spot, saldo_base_calculo_spot, ultima_atualizacao FROM contas WHERE id = ?`, [id]
      );
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }
      reply.send({
        success: true,
        saldo_spot: rows[0].saldo_spot,
        saldo_base_calculo_spot: rows[0].saldo_base_calculo_spot,
        ultima_atualizacao: rows[0].ultima_atualizacao
      });
    } catch (error) {
      fastify.log.error('Erro ao buscar saldo spot:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // GET /dashboard/account/:id/symbols
  fastify.get('/dashboard/account/:id/symbols', {
    schema: {
      description: 'Lista todos os symbols de futuros disponíveis para a corretora da conta selecionada.',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      },
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filtro de pesquisa (opcional)' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { search } = request.query;
    const db = await getDatabaseInstance();
    try {
      // 1. Buscar id_corretora da conta
      const [contaRows] = await db.query('SELECT id_corretora FROM contas WHERE id = ?', [id]);
      if (!contaRows.length) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }
      const idCorretora = contaRows[0].id_corretora;

      // 2. Buscar nome da corretora
      const [corretoraRows] = await db.query('SELECT corretora FROM corretoras WHERE id = ?', [idCorretora]);
      if (!corretoraRows.length) {
        return reply.status(404).send({ error: 'Corretora não encontrada' });
      }
      const exchange = corretoraRows[0].corretora.toLowerCase();

      // 3. Buscar symbols de futuros para essa corretora
      let query = `
        SELECT id, exchange, symbol, status, pair, contract_type, base_asset, quote_asset, margin_asset, price_precision, quantity_precision, base_asset_precision, quote_precision, onboard_date, liquidation_fee, market_take_bound, updated_at
        FROM exchange_symbols
        WHERE exchange = ? AND contract_type IS NOT NULL
      `;
      const params = [exchange];
      if (search) {
        query += ` AND (symbol LIKE ? OR pair LIKE ? OR base_asset LIKE ? OR quote_asset LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      }
      query += ' ORDER BY symbol ASC';

      const [symbols] = await db.query(query, params);
      reply.send({ success: true, data: symbols, total: symbols.length });
    } catch (error) {
      fastify.log.error('Erro ao buscar symbols:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // Atualização de saldos (futuros e spot) - nova rota
  fastify.post('/dashboard/account/:id/atualizar-saldos', {
    schema: {
      description: 'Atualiza os saldos de futuros e spot da conta consultando a corretora.',
      tags: ['Dashboard'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      // Atualiza saldo futuros
      const fut = await getFuturesAccountBalanceDetails(Number(id));
      // Atualiza saldo spot
      const spot = await getSpotAccountBalanceDetails(Number(id));

      if (!fut?.success && !spot?.success) {
        return reply.status(500).send({ error: 'Erro ao consultar saldos na corretora' });
      }

      reply.send({
        success: true,
        saldo_futuros: fut?.saldo,
        saldo_spot: spot?.saldo,
        atualizado_em: new Date().toISOString()
      });
    } catch (error) {
      fastify.log.error('Erro ao atualizar saldos:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });
}

module.exports = dashboardRoutes;