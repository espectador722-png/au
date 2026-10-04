@echo off
title Eclipse Zone - Deploy Script
color 0A

echo ================================================
echo    Eclipse Zone - Deploy Script (Windows)
echo ================================================
echo.

:: Verificar que Python este instalado
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python no esta instalado o no esta en el PATH
    echo Por favor instala Python desde https://python.org
    echo.
    pause
    exit /b 1
)

:: Mostrar ayuda de uso
if "%1"=="--help" goto :show_help
if "%1"=="-h"     goto :show_help

:: Ejecutar el deploy.py con todos los argumentos pasados al batch
echo Ejecutando: python scripts\deploy.py %*
echo.
echo -------------------------------------------------
python scripts\deploy.py %*

:: Verificar si hubo error
if errorlevel 1 (
    echo.
    echo -------------------------------------------------
    echo [ERROR] El despliegue fallo. Revisa los mensajes arriba.
)

:: Pausa para que el usuario vea el resultado
echo.
echo -------------------------------------------------
echo.
echo Presiona cualquier tecla para cerrar esta ventana...
pause >nul
exit /b 0

:show_help
echo.
echo USO:
echo   deploy.bat                  → genera sitio + deploy Pages
echo   deploy.bat --worker         → solo el Worker (wrangler deploy)
echo   deploy.bat --pages          → solo el sitio estatico
echo   deploy.bat --dry-run        → muestra los comandos sin ejecutar
echo   deploy.bat --help           → muestra esta ayuda
echo.
echo EJEMPLOS:
echo   deploy.bat                  → deploy completo
echo   deploy.bat --worker         → solo worker
echo   deploy.bat --pages          → solo sitio estatico
echo   deploy.bat --dry-run        → ver que haria sin ejecutar nada
echo.
pause
exit /b 0
