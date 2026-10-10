# Obliview

**Self-hosted, multi-tenant uptime and infrastructure monitoring, with native agents.**

Obliview watches websites, services and servers from one panel. It combines 13 monitor types, hierarchical groups whose settings inherit down the tree, and a cross-platform Go agent that reports host metrics. It is built for MSPs and IT teams who monitor many sites or customers from a single instance.

Website: [view.obli.tools](https://view.obli.tools)

## Key features

- **13 monitor types**: HTTP, Ping, TCP, DNS, SSL certificate, SMTP, Docker, game server, Push, Script, JSON API, Browser (headless Playwright) and Value Watcher.
- **Hierarchical groups with inheritance**: settings flow from global to group to monitor, with per-level overrides and reset.
- **Notifications**: Telegram, Discord, Slack, Microsoft Teams, e-mail (SMTP), webhook, Gotify, ntfy, Pushover and Free Mobile, with merge/replace bindings at each level and repeat-alert cooldowns.
- **Agents**: CPU, memory, disk and temperature sensors with editable thresholds and a real-time command channel, for Windows, Linux, macOS and FreeBSD.
- **Fleet management**: approve or suspend agents, move them between tenants, roll out agent updates at a controlled pace (automatic, manual or off).
- **Automatic remediation**: webhook, n8n, script, Docker restart or SSH actions when a monitor fails.
- **Maintenance windows**: one-time or recurring, scoped to the whole system, a group, a monitor or an agent.
- **Access control**: multi-tenancy, teams, permission sets and an audit log.
- **Security and UX**: two-factor authentication (TOTP or e-mail code, can be enforced), live alerts, import/export, 18 UI languages.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Obliview/main/install.sh | sh
```

The installer runs on Linux, or on macOS with Docker Desktop. It:

- checks Docker and Docker Compose; on Linux it offers to install them with Docker's official script, only after you confirm;
- downloads `docker-compose.yml` and `.env.example` into `./obliview`;
- creates `.env` with unique random secrets (`DB_PASSWORD`, `SESSION_SECRET`, initial admin password);
- pulls the images, starts the stack and prints the panel URL and the initial admin password (shown only once).

Running it again upgrades an existing install; `.env` is never modified.

Options (pass them after `sh -s --`):

| Option | Description |
|--------|-------------|
| `-y`, `--yes` | Non-interactive: accept the defaults and install Docker if it is missing |
| `--dir PATH` | Install directory (default `./obliview`) |
| `--port PORT` | Host port of the web interface (default `3000`, first install only) |
| `--url URL` | Public URL of the panel, e.g. `https://obliview.example.com` (first install only) |

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Obliview/main/install.sh | sh -s -- -y --dir /opt/obliview --url https://obliview.example.com
```

`--help` lists every option.

## Manual install (Docker Compose)

```sh
mkdir obliview && cd obliview
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Obliview/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Obliview/main/.env.example
cp .env.example .env
mkdir -p custom/scripts custom/.ssh
# Edit .env: set DB_PASSWORD, SESSION_SECRET (32+ characters), DEFAULT_ADMIN_PASSWORD
# and CLIENT_ORIGIN (the public URL of the panel).
docker compose up -d
```

The panel answers on port `3000` (`LISTEN_PORT`). The stack runs PostgreSQL 16, the server (`meejay/obliview-server`) and the web client (`meejay/obliview-client`). To use an existing PostgreSQL server instead, see `docker-compose.external-db.yml`.

## Update

```sh
docker compose pull && docker compose up -d
```

Or run the installer again from the same directory.

## Installing agents

Agents are installed from the panel, which provides the install command (Linux, macOS, FreeBSD) or the MSI (Windows) with your enrollment key. New agents wait for approval.

## Requirements

- A Linux host (or macOS with Docker Desktop) with Docker Engine and Docker Compose v2.
- HTTPS through a reverse proxy for production use: set `CLIENT_ORIGIN` in `.env` to the public `https://` address and `FORCE_HTTPS=true`, then run `docker compose up -d` again.

## Single sign-on

Obliview supports single sign-on with [Obligate](https://github.com/obli-tools/Obligate): register Obliview as an app in Obligate, then enter the Obligate URL and API key in the Obliview settings. Local accounts keep working alongside SSO.

## Part of the Obli suite

| Tool | Purpose |
|------|---------|
| [Obliance](https://ance.obli.tools) | Remote monitoring and management (RMM) |
| [Oblireach](https://reach.obli.tools) | Remote screen access and remote support |
| **[Obliview](https://view.obli.tools)** | Uptime and infrastructure monitoring |
| [Oblimap](https://map.obli.tools) | IPAM and network discovery |
| [Obliguard](https://guard.obli.tools) | Agent-based intrusion prevention |
| [Obligate](https://gate.obli.tools) | Single sign-on and access management for the suite |
| [Oblihub](https://hub.obli.tools) | Docker control panel |
| [Obliwan](https://github.com/obli-tools/Obliwan) | WAN router fleet management |
| [ObliDesk](https://github.com/obli-tools/ObliDesk) | Ticketing and service desk |
| [Obliplan](https://github.com/obli-tools/Obliplan) | Workforce scheduling and working-time tracking |
| [Oblifield](https://field.obli.tools) | Field intervention management |

Suite home: [obli.tools](https://obli.tools)

## License

Obliview is source-available under the [Elastic License 2.0](LICENSE) (ELv2). You may use, modify and self-host it, including for commercial use inside your organization; you may not provide it to others as a hosted or managed service. See [LICENSE](LICENSE) for the full terms, the obli.tools clarifications and third-party notices.
