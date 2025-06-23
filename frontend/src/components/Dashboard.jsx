import { useDashboard, useAccounts } from '../hooks/useApi';

export default function Dashboard() {
  const { stats, loading: statsLoading } = useDashboard();
  const { accounts, loading: accountsLoading, startAccount, stopAccount } = useAccounts();

  if (statsLoading || accountsLoading) {
    return <div>Carregando...</div>;
  }

  return (
    <div>
      <h1>Dashboard Starboy</h1>
      
      {/* Estatísticas */}
      <div>
        <h2>Estatísticas</h2>
        <p>Instâncias rodando: {stats?.system?.runningInstances}</p>
        <p>Total de contas: {stats?.system?.totalAccounts}</p>
      </div>

      {/* Lista de contas */}
      <div>
        <h2>Contas</h2>
        {accounts.map(account => (
          <div key={account.id}>
            <span>{account.nome} - {account.status}</span>
            <button onClick={() => startAccount(account.id)}>Iniciar</button>
            <button onClick={() => stopAccount(account.id)}>Parar</button>
          </div>
        ))}
      </div>
    </div>
  );
}