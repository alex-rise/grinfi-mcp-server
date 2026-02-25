# Grinfi MCP Server - Windows Installer
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Grinfi MCP Server - Quick Install    " -ForegroundColor Cyan
Write-Host "         for Windows                    " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

try {

# ----- Resolve script directory -----
$scriptDir = $null
if ($MyInvocation.MyCommand.Path) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if (-not $scriptDir -or -not (Test-Path $scriptDir)) {
    $scriptDir = Get-Location
}
Set-Location $scriptDir
Write-Host "Working directory: $scriptDir" -ForegroundColor Gray

# ----- Node.js -----
function Install-NodeJS {
    Write-Host "Node.js not found. Installing automatically..." -ForegroundColor Yellow
    Write-Host ""

    # Try winget first
    $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)

    if ($hasWinget) {
        Write-Host "Installing Node.js via winget..." -ForegroundColor Yellow
        & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        # Download and run MSI installer
        Write-Host "winget not available. Downloading Node.js installer..." -ForegroundColor Yellow
        $nodeUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        $msiPath = Join-Path $env:TEMP "node-installer.msi"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $nodeUrl -OutFile $msiPath -UseBasicParsing
        Write-Host "Running Node.js installer (follow the prompts)..." -ForegroundColor Yellow
        Start-Process msiexec.exe -ArgumentList "/i", "`"$msiPath`"" -Wait
        Remove-Item $msiPath -ErrorAction SilentlyContinue
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    }

    # Verify
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $v = & node -v
        Write-Host "OK Node.js $v installed" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "Node.js was installed but PowerShell cannot find it yet." -ForegroundColor Yellow
        Write-Host "Please CLOSE this window, open a NEW PowerShell, and run this script again." -ForegroundColor Yellow
        Write-Host ""
        Read-Host "Press Enter to exit"
        exit 1
    }
}

$nodeOk = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVersionRaw = & node -v
    if ($nodeVersionRaw) {
        $nodeVersionClean = $nodeVersionRaw -replace 'v', ''
        $major = [int]($nodeVersionClean.Split('.')[0])
        if ($major -ge 18) {
            Write-Host "OK Node.js $nodeVersionRaw detected" -ForegroundColor Green
            $nodeOk = $true
        } else {
            Write-Host "Node.js $nodeVersionRaw is too old (need 18+). Updating..." -ForegroundColor Yellow
        }
    }
}

if (-not $nodeOk) {
    Install-NodeJS
}

# ----- API Key -----
Write-Host ""
Write-Host "Enter your Grinfi API key" -ForegroundColor White
Write-Host "  Get it from: https://leadgen.grinfi.io/settings/api-keys" -ForegroundColor Cyan
Write-Host ""
$apiKey = Read-Host "  API Key"

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "API key cannot be empty." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "OK API key saved" -ForegroundColor Green

# ----- Install & Build -----
Write-Host ""
Write-Host "Installing dependencies (this may take a minute)..." -ForegroundColor White
& npm install 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed. Retrying with verbose output..." -ForegroundColor Yellow
    & npm install
}
Write-Host "OK Dependencies installed" -ForegroundColor Green

Write-Host "Building server..." -ForegroundColor White
& npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Retrying with verbose output..." -ForegroundColor Yellow
    & npm run build
}
Write-Host "OK Server built" -ForegroundColor Green

# ----- Configure Claude Desktop -----
Write-Host ""
Write-Host "Configuring Claude Desktop..." -ForegroundColor White

$claudeConfigDir = Join-Path $env:APPDATA "Claude"
$configFile = Join-Path $claudeConfigDir "claude_desktop_config.json"
$serverPath = (Join-Path $scriptDir "dist\index.js") -replace '\\', '/'

if (-not (Test-Path $claudeConfigDir)) {
    New-Item -ItemType Directory -Path $claudeConfigDir -Force | Out-Null
}

# Build config as raw JSON string to avoid PowerShell serialization issues
$grinfiBlock = @"
{
    "command": "node",
    "args": ["$serverPath"],
    "env": {
        "GRINFI_API_KEY": "$apiKey"
    }
}
"@

if (Test-Path $configFile) {
    try {
        $rawJson = Get-Content $configFile -Raw -Encoding UTF8
        $config = $rawJson | ConvertFrom-Json

        # Ensure mcpServers exists
        if (-not $config.mcpServers) {
            $config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue (New-Object PSObject) -Force
        }

        # Add or replace grinfi server
        $grinfiObj = $grinfiBlock | ConvertFrom-Json
        $config.mcpServers | Add-Member -NotePropertyName "grinfi" -NotePropertyValue $grinfiObj -Force

        $config | ConvertTo-Json -Depth 10 | Set-Content $configFile -Encoding UTF8
        Write-Host "OK Merged into existing config" -ForegroundColor Green
    } catch {
        Write-Host "Could not merge config, writing fresh..." -ForegroundColor Yellow
        $freshConfig = @"
{
  "mcpServers": {
    "grinfi": $grinfiBlock
  }
}
"@
        $freshConfig | Set-Content $configFile -Encoding UTF8
        Write-Host "OK Config written" -ForegroundColor Green
    }
} else {
    $freshConfig = @"
{
  "mcpServers": {
    "grinfi": $grinfiBlock
  }
}
"@
    $freshConfig | Set-Content $configFile -Encoding UTF8
    Write-Host "OK Config created" -ForegroundColor Green
}

# ----- Install Claude Code skill -----
Write-Host ""
Write-Host "Installing Claude Code skill..." -ForegroundColor White

$skillSource = Join-Path $scriptDir "SKILL.md"
$skillDir = Join-Path $env:USERPROFILE ".claude\skills\grinfi-mcp"

if (Test-Path $skillSource) {
    if (-not (Test-Path $skillDir)) {
        New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    }
    Copy-Item $skillSource (Join-Path $skillDir "SKILL.md") -Force
    Write-Host "OK Skill installed" -ForegroundColor Green
} else {
    Write-Host "SKILL.md not found - skipping" -ForegroundColor Yellow
}

# ----- Done -----
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "   Installation Complete!                " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  What to do now:" -ForegroundColor White
Write-Host "  1. Quit Claude Desktop completely (right-click taskbar icon > Close)" -ForegroundColor White
Write-Host "  2. Reopen Claude Desktop" -ForegroundColor White
Write-Host "  3. Look for 'grinfi' in the tools list (hammer icon)" -ForegroundColor Cyan
Write-Host "  4. Try: 'Show me all my Grinfi contacts'" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Config: $configFile" -ForegroundColor Yellow

} catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "   An error occurred:                   " -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "If you need help, visit:" -ForegroundColor Yellow
    Write-Host "  https://github.com/alex-rise/grinfi-mcp-server" -ForegroundColor Cyan
}

Write-Host ""
Read-Host "Press Enter to close this window"
