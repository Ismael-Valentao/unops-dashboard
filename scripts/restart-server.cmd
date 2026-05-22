@echo off
REM ==========================================================
REM Reinicia o serviço Windows "aqidashboard.exe".
REM
REM REQUER PRIVILÉGIOS DE ADMINISTRADOR (LocalSystem service).
REM
REM Como correr:
REM   1. Clique direito neste ficheiro → "Executar como administrador"
REM   OU
REM   2. Num PowerShell/CMD elevado:
REM      cd "C:\Users\Ismael Chiziane\Documents\Claude\aqi-dashboard"
REM      scripts\restart-server.cmd
REM ==========================================================

echo.
echo === A parar serviço aqidashboard.exe ===
net stop aqidashboard.exe
if errorlevel 1 (
  echo.
  echo *** ERRO: não foi possível parar o serviço.
  echo *** Reabra este ficheiro com "Executar como administrador".
  pause
  exit /b 1
)

echo.
echo === A arrancar serviço aqidashboard.exe ===
net start aqidashboard.exe
if errorlevel 1 (
  echo.
  echo *** ERRO ao arrancar — ver daemon\aqidashboard.err.log
  pause
  exit /b 1
)

echo.
echo === Aguardar 3s e verificar ===
timeout /t 3 /nobreak >nul
curl -s -o nul -w "HTTP %%{http_code}\n" http://localhost:5000/batedores

echo.
echo === Concluido. ===
echo Abra http://localhost:5000/batedores para testar o novo CAM-XX.
echo.
pause
