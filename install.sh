#!/bin/bash
#
# Claude Remote Agent - Quick Installation Script
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/your-org/claude-remote-agent/main/install.sh | bash
#
# Options:
#   --node-version VERSION   Node.js version to install (default: 20)
#   --install-dir PATH       Installation directory (default: /opt/claude-remote-agent)
#   --no-node               Skip Node.js installation
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
NODE_VERSION="20"
INSTALL_DIR="/opt/claude-remote-agent"
INSTALL_NODE=true

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --node-version)
            NODE_VERSION="$2"
            shift 2
            ;;
        --install-dir)
            INSTALL_DIR="$2"
            shift 2
            ;;
        --no-node)
            INSTALL_NODE=false
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║           Claude Remote Agent - Installation              ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Detect OS
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        VERSION=$VERSION_ID
    else
        OS="unknown"
        VERSION="unknown"
    fi
    ARCH=$(uname -m)
    echo -e "${YELLOW}Detected: $OS $VERSION ($ARCH)${NC}"
}

# Detect package manager
detect_pkg_manager() {
    if command -v apt-get &> /dev/null; then
        PKG_MANAGER="apt"
    elif command -v dnf &> /dev/null; then
        PKG_MANAGER="dnf"
    elif command -v yum &> /dev/null; then
        PKG_MANAGER="yum"
    elif command -v pacman &> /dev/null; then
        PKG_MANAGER="pacman"
    elif command -v apk &> /dev/null; then
        PKG_MANAGER="apk"
    else
        PKG_MANAGER="unknown"
    fi
    echo -e "${YELLOW}Package manager: $PKG_MANAGER${NC}"
}

# Check if Node.js is installed
check_node() {
    if command -v node &> /dev/null; then
        NODE_INSTALLED=true
        NODE_CURRENT=$(node --version | sed 's/v//')
        echo -e "${GREEN}Node.js already installed: v$NODE_CURRENT${NC}"
    else
        NODE_INSTALLED=false
        echo -e "${YELLOW}Node.js not installed${NC}"
    fi
}

# Install Node.js
install_node() {
    echo -e "\n${GREEN}[1/4] Installing Node.js $NODE_VERSION...${NC}"

    case $PKG_MANAGER in
        apt)
            curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        dnf)
            sudo dnf module enable "nodejs:${NODE_VERSION}" -y
            sudo dnf install nodejs -y
            ;;
        yum)
            curl -fsSL "https://rpm.nodesource.com/setup_${NODE_VERSION}.x" | sudo bash -
            sudo yum install nodejs -y
            ;;
        pacman)
            sudo pacman -S nodejs npm --noconfirm
            ;;
        apk)
            sudo apk add nodejs npm
            ;;
        *)
            echo -e "${RED}Unsupported package manager: $PKG_MANAGER${NC}"
            echo "Please install Node.js manually and re-run this script with --no-node"
            exit 1
            ;;
    esac

    echo -e "${GREEN}Node.js installed: $(node --version)${NC}"
}

# Install git if needed
install_git() {
    if ! command -v git &> /dev/null; then
        echo -e "\n${YELLOW}Installing git...${NC}"
        case $PKG_MANAGER in
            apt)
                sudo apt-get install -y git
                ;;
            dnf|yum)
                sudo yum install -y git
                ;;
            pacman)
                sudo pacman -S git --noconfirm
                ;;
            apk)
                sudo apk add git
                ;;
        esac
    fi
}

# Create installation directory
setup_dir() {
    echo -e "\n${GREEN}[2/4] Creating installation directory...${NC}"
    sudo mkdir -p "$INSTALL_DIR"
    sudo chown "$(whoami):$(whoami)" "$INSTALL_DIR"
}

# Clone and build
install_agent() {
    echo -e "\n${GREEN}[3/4] Downloading and building claude-remote-agent...${NC}"
    cd "$INSTALL_DIR"

    if [ -d ".git" ]; then
        git pull
    else
        git clone https://github.com/your-org/claude-remote-agent.git .
    fi

    npm install
    npm run build
}

# Create symlink
create_symlink() {
    echo -e "\n${GREEN}[4/4] Creating command symlink...${NC}"
    sudo ln -sf "$INSTALL_DIR/dist/cli.js" /usr/local/bin/claude-remote-agent
    sudo chmod +x /usr/local/bin/claude-remote-agent
}

# Initialize config
init_config() {
    echo -e "\n${YELLOW}Initializing configuration...${NC}"
    claude-remote-agent init
}

# Main installation flow
main() {
    detect_os
    detect_pkg_manager
    check_node

    # Install Node.js if needed
    if [ "$INSTALL_NODE" = true ] && [ "$NODE_INSTALLED" = false ]; then
        install_node
    elif [ "$NODE_INSTALLED" = false ]; then
        echo -e "${RED}Node.js is required but --no-node was specified${NC}"
        exit 1
    fi

    install_git
    setup_dir
    install_agent
    create_symlink
    init_config

    echo -e "\n${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║              Installation Complete!                       ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo "Claude Remote Agent installed to: $INSTALL_DIR"
    echo "Command available at: /usr/local/bin/claude-remote-agent"
    echo ""
    echo "Next steps:"
    echo "  1. Edit ~/.config/claude-remote-agent/hosts.yaml to add hosts"
    echo "  2. Run 'claude-remote-agent list' to see configured hosts"
    echo "  3. Run 'claude-remote-agent test <host>' to test connections"
    echo ""
}

main
