@echo off
REM ==========================================================================
REM Reinicia o serviço Windows "AQI Dashboard" (aqidashboard.exe).
REM
REM USO:
REM   Click DIREITO neste ficheiro → "Executar como administrador"
REM
REM Se precisares só de PARAR ou INICIAR, vê os 2 ficheiros à parte:
REM   stop-service.bat / start-service.bat
REM ==========================================================================

REM Auto-elevação UAC: se não estamos como admin, re-lança como admin
net session >nul 2>&1
if errorlevel 1 (
    echo Pedindo permissao de Administrador...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo ============================================================
echo  AQI Dashboard - Reiniciando servico
echo ============================================================
echo.

echo Parando 'aqidashboard.exe'...
net stop "aqidashboard.exe"
if errorlevel 1 (
    echo.
    echo ATENCAO: Falhou parar. Pode ser que ja estivesse parado.
    echo.
)

timeout /t 2 /nobreak >nul

echo.
echo Iniciando 'aqidashboard.exe'...
net start "aqidashboard.exe"
if errorlevel 1 (
    echo.
    echo ERRO: Falhou iniciar. Verifica:
    echo   - O servico esta instalado? (services.msc)
    echo   - Ha erros recentes? (type %%LOCALAPPDATA%%\AQI_Dashboard.daemon\aqidashboard.err.log)
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  OK - Servico reiniciado!
echo  Acede em: http://localhost:5000
echo ============================================================
echo.
timeout /t 4 /nobreak >nul
exit /b 0
