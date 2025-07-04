#!/bin/bash

# Script para obter o IP da máquina local

echo "🌐 Detectando IP da máquina..."

# Tentar diferentes métodos para obter o IP
if command -v ip &> /dev/null; then
    # Linux com ip command
    LOCAL_IP=$(ip route get 1 | awk '{print $NF; exit}')
    echo "✅ IP detectado via 'ip': $LOCAL_IP"
elif command -v ifconfig &> /dev/null; then
    # Linux/macOS com ifconfig
    LOCAL_IP=$(ifconfig | grep -E "inet.*broadcast" | awk '{print $2}' | head -1)
    echo "✅ IP detectado via 'ifconfig': $LOCAL_IP"
elif command -v hostname &> /dev/null; then
    # Windows/Linux com hostname
    LOCAL_IP=$(hostname -I | awk '{print $1}')
    echo "✅ IP detectado via 'hostname': $LOCAL_IP"
else
    echo "⚠️  Não foi possível detectar o IP automaticamente"
    echo "💡 Use 'ipconfig' (Windows) ou 'ifconfig' (Linux/macOS) para descobrir manualmente"
    LOCAL_IP="<IP_DA_MAQUINA>"
fi

echo ""
echo "🔗 URLs de acesso:"
echo "   📡 Backend:  http://$LOCAL_IP:8050"
echo "   🌐 Frontend: http://$LOCAL_IP:3050"
echo "   📚 API Docs: http://$LOCAL_IP:8050/docs"
echo ""
echo "💡 Compartilhe essas URLs para acesso externo!"
