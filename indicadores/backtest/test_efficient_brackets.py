"""
Script para testar a atualização eficiente de brackets
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from divap import update_leverage_brackets_database, get_database_connection

def test_efficient_update():
    print("=== TESTE DE ATUALIZAÇÃO EFICIENTE ===\n")
    
    # 1. Verificar estado inicial
    print("1. Verificando estado inicial do banco...")
    conn = get_database_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(*) FROM alavancagem WHERE corretora = 'binance'")
    initial_count = cursor.fetchone()[0]
    print(f"   Registros iniciais: {initial_count}")
    
    cursor.execute("SELECT COUNT(DISTINCT symbol) FROM alavancagem WHERE corretora = 'binance'")
    initial_symbols = cursor.fetchone()[0]
    print(f"   Símbolos iniciais: {initial_symbols}")
    
    # 2. Primeira execução (deve fazer muitas mudanças se for a primeira vez)
    print("\n2. Executando primeira atualização...")
    success1 = update_leverage_brackets_database()
    
    if not success1:
        print("❌ Primeira atualização falhou!")
        return
    
    # 3. Verificar após primeira execução
    cursor.execute("SELECT COUNT(*) FROM alavancagem WHERE corretora = 'binance'")
    after_first_count = cursor.fetchone()[0]
    print(f"   Registros após primeira execução: {after_first_count}")
    
    cursor.execute("SELECT COUNT(DISTINCT symbol) FROM alavancagem WHERE corretora = 'binance'")
    after_first_symbols = cursor.fetchone()[0]
    print(f"   Símbolos após primeira execução: {after_first_symbols}")
    
    # 4. Segunda execução (deve detectar que não há mudanças)
    print("\n3. Executando segunda atualização (deve detectar 'nenhuma mudança')...")
    success2 = update_leverage_brackets_database()
    
    if not success2:
        print("❌ Segunda atualização falhou!")
        return
    
    # 5. Verificar após segunda execução
    cursor.execute("SELECT COUNT(*) FROM alavancagem WHERE corretora = 'binance'")
    after_second_count = cursor.fetchone()[0]
    print(f"   Registros após segunda execução: {after_second_count}")
    
    # 6. Simular mudança para testar detecção
    print("\n4. Simulando mudança para testar detecção...")
    
    # Alterar um registro
    cursor.execute("""
        UPDATE alavancagem 
        SET initial_leverage = 999, updated_at = NOW() 
        WHERE corretora = 'binance' 
        LIMIT 1
    """)
    conn.commit()
    
    # Inserir registro fictício
    cursor.execute("""
        INSERT INTO alavancagem 
        (symbol, corretora, bracket, initial_leverage, notional_cap, notional_floor, maint_margin_ratio, cum, updated_at)
        VALUES ('TESTCOIN', 'binance', 999, 1, 1000000, 0, 0.1, 0, NOW())
    """)
    conn.commit()
    
    print("   Alteração simulada aplicada")
    
    # 7. Terceira execução (deve detectar e corrigir as mudanças)
    print("\n5. Executando terceira atualização (deve detectar e corrigir mudanças)...")
    success3 = update_leverage_brackets_database()
    
    if not success3:
        print("❌ Terceira atualização falhou!")
        return
    
    # 8. Verificar se mudanças foram corrigidas
    cursor.execute("SELECT COUNT(*) FROM alavancagem WHERE symbol = 'TESTCOIN' AND corretora = 'binance'")
    testcoin_count = cursor.fetchone()[0]
    
    cursor.execute("SELECT COUNT(*) FROM alavancagem WHERE initial_leverage = 999 AND corretora = 'binance'")
    fake_leverage_count = cursor.fetchone()[0]
    
    cursor.close()
    conn.close()
    
    print(f"\n6. Resultados finais:")
    print(f"   Registros TESTCOIN restantes: {testcoin_count} (deve ser 0)")
    print(f"   Registros com alavancagem 999x: {fake_leverage_count} (deve ser 0)")
    
    if testcoin_count == 0 and fake_leverage_count == 0:
        print("\n✅ TESTE PASSOU! A atualização eficiente está funcionando corretamente:")
        print("   - Detecta quando não há mudanças")
        print("   - Remove dados obsoletos")
        print("   - Corrige dados alterados")
    else:
        print("\n❌ TESTE FALHOU! Verificar implementação")

if __name__ == "__main__":
    test_efficient_update()