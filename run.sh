#!/bin/bash
# run.sh — inicia MoreSim en modo desarrollo local
# Uso: ./run.sh

set -e

# Verificar Node.js
if ! command -v node &> /dev/null; then
  echo "❌  Node.js no encontrado. Instalar desde https://nodejs.org (v18 o superior)"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌  Node.js $NODE_VER detectado. Se requiere v18 o superior."
  exit 1
fi

echo "✓  Node.js $(node -v)"

# Instalar dependencias si hace falta
if [ ! -d "node_modules" ]; then
  echo "📦  Instalando dependencias..."
  npm install
fi

echo ""
echo "🚀  Iniciando MoreSim..."
echo "    URL local:  http://localhost:5174"
echo "    URL red:    http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<tu-ip>'):5174"
echo ""
echo "    Primera apertura: el grafo de Morelia se descarga ~30s"
echo "    Ctrl+C para detener"
echo ""

npm run dev
