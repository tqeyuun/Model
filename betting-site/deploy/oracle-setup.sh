#!/bin/bash
# Oracle Cloud (Ubuntu) 서버에서 한 번만 실행:  bash deploy/oracle-setup.sh
# 하는 일: Node 22 설치 → 80번 포트 열기 → 재부팅해도 자동으로 켜지는 서비스 등록
set -e
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="$(whoami)"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

# 오라클 우분투는 방화벽(iptables)이 80번을 막고 있어서 허용 규칙을 맨 위에 추가
if ! sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
  sudo netfilter-persistent save 2>/dev/null || sudo sh -c 'iptables-save > /etc/iptables/rules.v4'
fi

sudo tee /etc/systemd/system/dobak.service >/dev/null <<EOF
[Unit]
Description=dobakjang
After=network.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PORT=80
Environment=DB_FILE=$APP_DIR/data.db
ExecStart=$(command -v node) --no-warnings server.js
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dobak
sleep 2
echo "=============================="
sudo journalctl -u dobak -n 5 --no-pager | sed 's#localhost#'"$(curl -s ifconfig.me)"'#'
echo "=============================="
echo "위 '관리자' 링크는 나만 알고 있기! (다시 보려면: sudo journalctl -u dobak | grep 관리자)"
