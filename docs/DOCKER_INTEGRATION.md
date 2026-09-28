# Docker CLI Integration

CLIHarbor includes a small first-party read-only Docker pack at:

```text
packs/docker/docker.yaml
```

The pack is embedded for normal `serve` and `doctor` startup alongside the Conjur pack. Docker itself is **not** bundled, downloaded, installed, configured, or authenticated by CLIHarbor. The normal discovery and executable-identity pipeline remains authoritative.

## Upstream command baseline

The initial pack is derived from Docker's official CLI reference for:

- `docker version --format json`
- `docker container ls --all --format <template>`
- `docker image ls --all --format <template>`
- `docker network ls --format <template>`
- `docker volume ls --format <template>`

Official references:

- https://docs.docker.com/reference/cli/docker/version/
- https://docs.docker.com/reference/cli/docker/container/ls/
- https://docs.docker.com/reference/cli/docker/image/ls/
- https://docs.docker.com/reference/cli/docker/network/ls/
- https://docs.docker.com/reference/cli/docker/volume/ls/

## Safety scope

The first pack is intentionally inventory-only. It excludes:

- container command lines;
- labels;
- environment/config inspection;
- logs;
- `exec`;
- file copy;
- context switching;
- registry authentication;
- Docker configuration files;
- Swarm secrets/config contents;
- create/start/stop/restart/remove/prune/pull/push/build operations.

The container-list format includes only ID, name, image, state/status, and published ports. Network output excludes labels and endpoint detail. Volume output excludes labels and host mount paths.

All tasks remain `risk: read`, use deterministic trusted argv, and do not persist raw output.

## Runtime qualification

Public CI validates the pack schema, static lint contract, and exact production-planner argv without requiring a Docker daemon. Real execution still depends on an approved local Docker CLI and reachable Docker Engine.

CLIHarbor does not auto-provision Docker. A missing or ambiguous Docker executable remains unavailable until the operator or organization supplies an approved installation/path.
