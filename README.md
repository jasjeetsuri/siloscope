# Silo Monitor

A low-overhead, mobile-first wallboard for Silo CPU, memory, network bandwidth, disk usage, playback-node health, and active playback sessions. A small Go server keeps the Silo API key out of the browser and retains five minutes of CPU, memory, download, and upload samples in memory so charts survive page reloads.

## Run with Docker Compose

1. Copy `.env.example` to `.env`.
2. Set `SILO_URL` to the Silo address reachable from the container.
3. Set `SILO_API_KEY` to an unscoped API key owned by an enabled Silo admin.
4. Start the service:

   ```sh
   docker compose up -d
   ```

The default local URL is `http://127.0.0.1:8091`. The health endpoint is `/healthz`.

The Silo admin resource and session routes are not covered by the currently available scoped API-key permissions. Treat the key as a secret: keep `.env` out of source control and do not put the key in Pangolin or browser configuration.

## Pangolin

When Newt runs on the Docker host, create a Pangolin HTTP resource targeting `http://127.0.0.1:8091`.

When Newt runs in Docker, attach both containers to the same Docker network, remove the public `ports` mapping if it is not needed, and target `http://silo-monitor:8080` from Newt. Pangolin should terminate HTTPS for the public hostname.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SILO_URL` | required | Silo base URL reachable by the monitor container |
| `SILO_API_KEY` | required | Silo admin API key |
| `LISTEN_ADDR` | `:8080` | Address used by the Go server |
| `MONITOR_BIND` | `127.0.0.1` | Host address published by Compose |
| `MONITOR_PORT` | `8091` | Host port published by Compose |
| `HOST_NETWORK_INTERFACE` | `eth0` | Host NIC used by the optional bandwidth override |
| `HOST_NETWORK_STATS_DIR` | unset | Directory containing host NIC `rx_bytes` and `tx_bytes` counters |

The server samples resources every 5 seconds into a bounded in-memory history. The browser polls the current resource sample every 5 seconds and sessions every 15 seconds while visible. Resource responses are cached for 4 seconds and session responses for 10 seconds. Browser polling pauses when Mobile Safari backgrounds the tab; server history collection continues.

The image is published for AMD64 and ARM64 at `ghcr.io/jasjeetsuri/silo-monitor:latest`.

To report total host ingress and egress instead of traffic in the monitor container namespace, set `HOST_NETWORK_INTERFACE` in `.env` to the host's public/default-route interface and start with the optional override:

```sh
docker compose -f compose.yaml -f compose.host-network.yaml up -d
```

You can find the interface with `ip route show default`. The override mounts only that interface's byte counters read-only.

## Build locally

```sh
docker build -t silo-monitor:local .
```