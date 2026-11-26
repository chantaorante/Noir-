# Deployment on the Dedicated Ubuntu Computer

Target: the home desktop (Intel Core i5 7th gen, 16 GB RAM, 256 GB SSD, Ethernet), running 24/7.

> **Destructive step warning.** Installing Ubuntu **erases the existing Windows installation and all data on the SSD**.
> Copy anything you need off the machine first. Nothing in this guide is run automatically.

## 1. Verify the hardware (before and after install)

| Check | Command (after Ubuntu install) | Expectation |
|---|---|---|
| CPU model | `lscpu \| grep 'Model name'` | i5-7xxx (Kaby Lake) is fully supported by kernel 6.8 |
| RAM | `free -h` | 15+ GiB usable |
| SSD health | `sudo smartctl -a /dev/sda` | `PASSED`, low reallocated sectors, wear level reasonable |
| Network | `ip -br a`, `ethtool <iface>` | 1000Mb/s full duplex |
| Upload bandwidth | `speedtest` or speedtest.net from a LAN device | The real limit for remote players |

Before installing, check in the BIOS/UEFI: enable **"Restore on AC power loss: Power On"** so the server restarts after a power cut,
disable sleep and hibernate, and leave Secure Boot on (it is supported).

## 2. Install Ubuntu Server 24.04 LTS

1. Download `ubuntu-24.04.x-live-server-amd64.iso` from ubuntu.com, then verify its SHA256 against the published `SHA256SUMS`.
2. Write it to a USB stick (balenaEtcher or Rufus) and boot from it.
3. Choose **Ubuntu Server (minimized)** and use the entire disk with LVM. Set a hostname such as `noir`, and create your admin user.
4. Enable **Install OpenSSH server** and import your SSH public key from GitHub/Launchpad, or add it later with `ssh-copy-id`.
5. Skip the snaps (Docker comes from Docker's own repository).
6. After the reboot: `sudo apt update && sudo apt full-upgrade -y && sudo reboot`.
7. Give the server a **static IP** with a DHCP reservation on your router, e.g. `192.168.1.50`.

## 3. Harden the host and install Docker

From your laptop, `ssh admin@192.168.1.50`, then:

```bash
sudo apt install -y git
sudo git clone <your NOIR repository URL> /opt/noir
sudo chown -R $USER:$USER /opt/noir
cd /opt/noir
sudo ./infra/scripts/harden-host.sh 192.168.1.0/24 $USER     # asks for YES; read the script first
exit   # log in again so the docker group applies
```

The script does the following: installs Docker Engine, ufw, fail2ban, unattended-upgrades, age and smartmontools. UFW allows only
22/80/443 from the LAN. SSH becomes key-only with root login disabled. Docker log rotation is configured.
*Note:* the DOCKER-USER iptables rule in that script does not survive a reboot. Your router's NAT already blocks inbound traffic
unless you add port forwards, and **NOIR's remote-access design needs no port forwarding**.

## 4. Configure secrets

```bash
cd /opt/noir
cp .env.example .env && chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^NOIR_DATA_KEY=.*/NOIR_DATA_KEY=$(openssl rand -hex 32)/" .env
nano .env    # set PUBLIC_ORIGINS and NOIR_HOSTNAME
```

`NOIR_DATA_KEY` encrypts TOTP secrets, so **back it up offline** (password manager). Without it, all users must re-enrol 2FA.

## 5. Start NOIR

```bash
docker compose -f infra/docker-compose.yml --env-file .env up -d --build
docker compose -f infra/docker-compose.yml --env-file .env ps        # all "healthy"/"running"
docker compose -f infra/docker-compose.yml --env-file .env exec app node apps/server/dist/cli/create-owner.js owner "Your Name"
```

Open the printed link (`https://noir.lan/reset-password#…`) to set the Owner password, then go to **Settings → Security** and enable two-factor
authentication. **Admin features stay locked until 2FA is on.**

## 6. LAN access (no domain needed)

* Add `192.168.1.50 noir.lan` to each device's hosts file, or create a DNS entry on the router (many routers support local DNS),
  or Pi-hole/AdGuard.
* Caddy uses its own local CA (`NOIR_TLS=internal`). Install its root certificate on each device once:
  `docker compose -f infra/docker-compose.yml exec caddy cat /data/caddy/pki/authorities/local/root.crt > noir-root.crt`
  and import it on the device (on iOS and Android: Settings → Security → Install certificate).

## 7. Remote access (optional)

**Recommended: Cloudflare Tunnel**, with no open ports and the home IP hidden.

1. You need a domain whose DNS is on Cloudflare (about €10 a year for a typical `.com`; Cloudflare's free plan is enough).
2. In Cloudflare Zero Trust → Networks → Tunnels: create a tunnel and copy its token into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.
3. Add a public hostname `poker.example.com` → service `http://caddy:8080`.
4. Add `https://poker.example.com` to `PUBLIC_ORIGINS`, then run
   `docker compose -f infra/docker-compose.yml --env-file .env --profile tunnel up -d`.
5. Optional extra gate: put a Cloudflare Access policy (allowed emails) in front of the hostname. Only your invitees reach the login page.

Limitations to accept: Cloudflare terminates TLS, so it can technically see the traffic. Remote access depends on Cloudflare availability.
WebSockets are supported on the free plan. **SSH and PostgreSQL are never exposed** through the tunnel.

Alternative without Cloudflare: Tailscale or WireGuard VPN for invitees (private, but every player must install a VPN client).

## 8. Backups

See [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md). In short: generate an age key pair **on another computer**, copy only the public key
to `/etc/noir/backup-recipient.txt`, then install the timer:

```bash
sudo cp infra/systemd/noir-backup.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now noir-backup.timer
```

## 9. Updating and maintenance

| Task | Command |
|---|---|
| Status | `./infra/scripts/status.sh` |
| Update (backs up first) | `./infra/scripts/update.sh` |
| Logs | `docker compose -f infra/docker-compose.yml logs -f app` |
| Restart app | `docker compose -f infra/docker-compose.yml restart app` |
| OS updates | Automatic security updates; monthly `sudo apt full-upgrade && sudo reboot` |
| Undo SSH hardening | `sudo rm /etc/ssh/sshd_config.d/10-noir.conf && sudo systemctl reload ssh` (from the local console) |

## 10. What survives what

| Event | Behaviour |
|---|---|
| App restart or crash | Running hands are **voided**. Every player keeps their pre-hand stack (stacks are persisted per hand), and seats are restored. |
| DB restart | The pool reconnects. Requests fail during the outage and `/readyz` reports 503. |
| Power loss | Postgres WAL guarantees committed data. Containers restart (`restart: unless-stopped`) once the BIOS powers the machine back on. |
| Network loss | Players' turns time out (check/fold). Disconnected players are cashed out after 10 minutes. |

*These behaviours are tested at the application level (see TESTING.md). A real power-cut test on the target machine is part of Phase 10.*
