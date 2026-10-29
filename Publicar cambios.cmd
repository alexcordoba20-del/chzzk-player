@echo off
title Publicar cambios de CHZZK Player
rem Sube a GitHub los cambios de esta carpeta. Los demas PCs los instalan solos en unos minutos
rem (o al abrir la app). Solo funciona en el PC donde esta configurado git.
cd /d "%~dp0"
git add -A
git diff --cached --quiet && (echo No hay cambios que publicar. & pause & exit /b)
git status --short
set /p MSG=Describe el cambio (Enter = "Cambios"):
if "%MSG%"=="" set MSG=Cambios
git commit -q -m "%MSG%" && git push -q && echo. && echo Publicado. Los demas PCs se actualizaran solos.
pause
