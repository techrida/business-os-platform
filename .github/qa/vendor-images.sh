#!/usr/bin/env bash
set -euo pipefail
mapfile -t images < <(docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml --profile '*' config --no-interpolate --format json |
  jq -er '.services | .["zitadel-api","valkey","caddy","clamav","gotenberg","mailpit","seed-zitadel"].image' | sort -u)
[[ ${#images[@]} == 7 ]]
tags=()
for ref in "${images[@]}"; do
  [[ "$ref" == *@sha256:* ]]
  tag="${ref%@*}"
  if [[ "$1" == save ]]; then
    docker pull "$ref"
    docker tag "$ref" "$tag"
  fi
  tags+=("$tag")
done
if [[ "$1" == save ]]; then
  docker save -o "$RUNNER_TEMP/qa-vendor.tar" "${tags[@]}"
else
  docker load -i "$RUNNER_TEMP/qa-vendor.tar"
  # docker load restores tags. Attach the pinned manifests, reusing the layers already present.
  for ref in "${images[@]}"; do docker pull "$ref"; done
fi
