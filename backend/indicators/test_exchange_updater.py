#!/usr/bin/env python3
"""
Script para testar o exchange_info_updater.py com timeout
"""

import subprocess
import sys
import os
import threading
import time

def run_with_timeout(command, timeout_seconds=30):
    """Executa um comando com timeout"""
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Timeout expired"
    except Exception as e:
        return -1, "", str(e)

def test_exchange_updater():
    """Testa o script de atualização da exchange"""
    print("="*60)
    print("🔍 TESTE DO EXCHANGE INFO UPDATER")
    print("="*60)
    
    # Executar o script com timeout
    cmd = "python exchange_info_updater.py"
    returncode, stdout, stderr = run_with_timeout(cmd, timeout_seconds=30)
    
    if returncode == -1:
        print(f"❌ Script não completou em 30 segundos ou falhou")
        if stderr:
            print(f"Erro: {stderr}")
        return False
    
    # Verificar se houve erro de chave estrangeira
    output = stdout + stderr
    if "chave estrangeira" in output.lower() or "foreign key" in output.lower():
        print("❌ Erro de chave estrangeira ainda presente!")
        print("Saída:", output)
        return False
    
    if "symbol_id)=(0)" in output:
        print("❌ Erro de symbol_id=0 ainda presente!")
        print("Saída:", output)
        return False
    
    # Verificar se houve algum erro crítico
    if "❌ Erro crítico" in output:
        print("❌ Erro crítico encontrado!")
        print("Saída:", output)
        return False
    
    print("✅ Script executado sem erros de chave estrangeira")
    print("✅ Correção bem-sucedida!")
    
    if stdout:
        print("\nSaída do script:")
        print(stdout)
    
    return True

if __name__ == "__main__":
    success = test_exchange_updater()
    if success:
        print("\n🎉 Teste do exchange updater passou! Erro foi corrigido.")
    else:
        print("\n💥 Teste do exchange updater falhou! Ainda há problemas.")
        sys.exit(1)
