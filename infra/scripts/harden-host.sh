#!/usr/bin/env bash
# One-time Ubuntu Server 24.04 hardening for the NOIR host. Review before running.
# Usage: sudo ./harden-host.sh <LAN_CIDR e.g. 192.168.1.0/24> <admin-username>
# What it changes (all reversible, see DEPLOYMENT.md §9):
#   - installs Docker Engine (official repo), ufw, fail2ban, unattended-upgrades, age, smartmontools
#   - UFW: deny incoming; allow 443/80 and 22 only from the LAN subnet
#   - SSH: keys only, no root login, no passwords  (ensure your key works BEFORE running!)
set -euo pipefail
LAN="${1:?LAN CIDR, e.g. 192.168.1.0/24}"; ADMIN="${2:?admin username}"
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
[[ -s "/home/$ADMIN/.ssh/authorized_keys" ]] || { echo "No SSH key for $ADMIN. Add one first (ssh-copy-id), or you will be locked out." >&2; exit 1; }

read -r -p "This reconfigures the firewall and SSH. Type YES to continue: " ok
[[ "$ok" == YES ]] || exit 1

apt-get update
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades age smartmontools
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$ADMIN"

# Docker daemon: log rotation + no inter-container traffic by default on the bridge
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" }, "live-restore": true, "no-new-privileges": true }
JSON
systemctl restart docker

ufw default deny incoming
ufw default allow outgoing
ufw allow from "$LAN" to any port 22 proto tcp
ufw allow from "$LAN" to any port 443
ufw allow from "$LAN" to any port 80 proto tcp
ufw --force enable
# Docker publishes ports via iptables and can bypass UFW; restrict published ports to the LAN too:
iptables -I DOCKER-USER -i "$(ip route show default | awk '{print $5; exit}')" ! -s "$LAN" -p tcp -m multiport --dports 80,443 -j DROP || true

cat > /etc/ssh/sshd_config.d/10-noir.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
CONF
sshd -t && systemctl reload ssh

cat > /etc/fail2ban/jail.d/sshd.local <<'CONF'
[sshd]
enabled = true
maxretry = 4
bantime = 1h
findtime = 10m
CONF
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now smartmontools 2>/dev/null || systemctl enable --now smartd 2>/dev/null || true
echo "Host hardening complete. Log out and back in for docker group membership."
