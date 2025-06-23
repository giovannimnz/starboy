import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/api';

export function useApi(endpoint, options = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.request(endpoint, options);
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [endpoint, JSON.stringify(options)]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useAccounts() {
  const { data, loading, error, refetch } = useApi('/accounts');
  
  const startAccount = async (accountId) => {
    await apiClient.startAccount(accountId);
    refetch();
  };

  const stopAccount = async (accountId) => {
    await apiClient.stopAccount(accountId);
    refetch();
  };

  const restartAccount = async (accountId) => {
    await apiClient.restartAccount(accountId);
    refetch();
  };

  return {
    accounts: data?.data || [],
    loading,
    error,
    refetch,
    startAccount,
    stopAccount,
    restartAccount
  };
}

export function useDashboard() {
  const { data, loading, error, refetch } = useApi('/dashboard/stats');
  
  return {
    stats: data?.data || null,
    loading,
    error,
    refetch
  };
}