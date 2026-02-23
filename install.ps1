# Grinfi MCP Server — Windows Installer
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Grinfi MCP Server - Quick Install    " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 18) {
        Write-Host "Node.js 18+ is required. You have v$nodeVersion." -ForegroundColor Red
        Write-Host "Download from https://nodejs.org" -ForegroundColor Cyan
        exit 1
    }
    Write-Host "OK Node.js v$nodeVersion detected" -ForegroundColor Green
} catch {
    Write-Host "Node.js is not installed." -ForegroundColor Red
    Write-Host "Download from https://nodejs.org" -ForegroundColor Cyan
    exit 1
}

# Get API key
Write-Host ""
Write-Host "Step 1: Enter your Grinfi API key" -ForegroundColor White
Write-Host "  Get it from: Grinfi.io -> Settings -> API Keys" -ForegroundColor Cyan
Write-Host ""
$apiKey = Read-Host "  API Key"

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "API key cannot be empty." -ForegroundColor Red
    exit 1
}

Write-Host "OK API key saved" -ForegroundColor Green

# Install & build
Write-Host ""
Write-Host "Step 2: Installing dependencies..." -ForegroundColor White

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

npm install --silent 2>&1 | Out-Null
Write-Host "OK Dependencies installed" -ForegroundColor Green

npm run build --silent 2>&1 | Out-Null
Write-Host "OK Server built" -ForegroundColor Green

# Configure Claude Desktop
Write-Host ""
Write-Host "Step 3: Configuring Claude Desktop..." -ForegroundColor White

$claudeConfigDir = Join-Path $env:APPDATA "Claude"
$configFile = Join-Path $claudeConfigDir "claude_desktop_config.json"
$serverPath = (Join-Path $scriptDir "dist\index.js") -replace '\\', '/'

if (!(Test-Path $claudeConfigDir)) {
    New-Item -ItemType Directory -Path $claudeConfigDir -Force | Out-Null
}

$newServer = @{
    command = "node"
    args = @($serverPath)
    env = @{
        GRINFI_API_KEY = $apiKey
    }
}

if (Test-Path $configFile) {
    try {
        $config = Get-Content $configFile -Raw | ConvertFrom-Json
        if (-not $config.mcpServers) {
            $config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{} -Force
        }
        $config.mcpServers | Add-Member -NotePropertyName "grinfi" -NotePropertyValue $newServer -Force
        $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
        Write-Host "OK Merged into existing config" -ForegroundColor Green
    } catch {
        $config = @{ mcpServers = @{ grinfi = $newServer } }
        $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
        Write-Host "OK Config written" -ForegroundColor Green
    }
} else {
    $config = @{ mcpServers = @{ grinfi = $newServer } }
    $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
    Write-Host "OK Config created" -ForegroundColor Green
}

# Install Claude Code skill
Write-Host ""
Write-Host "Step 4: Installing Claude Code skill..." -ForegroundColor White

$skillSource = Join-Path $scriptDir "SKILL.md"
$skillDir = Join-Path $env:USERPROFILE ".claude\skills\grinfi-mcp"

if (Test-Path $skillSource) {
    if (!(Test-Path $skillDir)) {
        New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    }
    Copy-Item $skillSource (Join-Path $skillDir "SKILL.md") -Force
    Write-Host "OK Skill installed to $skillDir\SKILL.md" -ForegroundColor Green
} else {
    Write-Host "SKILL.md not found in repo — skipping skill install" -ForegroundColor Yellow
}

# Done
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "   Installation Complete!                " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "  1. Restart Claude Desktop (quit and reopen)" -ForegroundColor White
Write-Host "  2. Look for 'grinfi' in the MCP tools list" -ForegroundColor Cyan
Write-Host "  3. Try: 'Show me all my Grinfi contacts'" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Config: $configFile" -ForegroundColor Yellow
Write-Host "  Skill:  $skillDir\SKILL.md" -ForegroundColor Yellow
Write-Host ""
