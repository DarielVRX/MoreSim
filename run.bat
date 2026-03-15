@echo off
REM run.bat — inicia MoreSim en modo desarrollo local (Windows)
REM Uso: run.bat

echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js no encontrado. Instalar desde https://nodejs.org ^(v18 o superior^)
  pause
  exit /b 1
)

echo Verificando Node.js...
node -v

if not exist "node_modules\" (
  echo.
  echo Instalando dependencias...
  npm install
  if %errorlevel% neq 0 (
    echo ERROR al instalar dependencias
    pause
    exit /b 1
  )
)

echo.
echo Iniciando MoreSim...
echo URL: http://localhost:5174
echo.
echo Primera apertura: el grafo de Morelia se descarga ~30s
echo Ctrl+C para detener
echo.

npm run dev
