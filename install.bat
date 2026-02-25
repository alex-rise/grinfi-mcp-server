@echo off
title Grinfi MCP Server - Installer
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0install.ps1"
