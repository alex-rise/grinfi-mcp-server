#!/bin/bash
# Double-click this file on macOS to install Grinfi MCP Server.
# It will open Terminal.app automatically.

cd "$(dirname "$0")"
bash ./install.sh

echo ""
echo "You can close this window now."
read -n 1 -s -r -p "Press any key to close..."
