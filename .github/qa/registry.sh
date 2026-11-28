#!/usr/bin/env bash
# Use immutable commit tags for these QA-only images. The producer is the only writer.
set -euo pipefail
images=(bos/postgres:16 bos-zitadel-login)
registry="ghcr.io/${GITHUB_REPOSITORY,,}/qa"
revision=$GITHUB_SHA
if [[ "$1" == pull ]]; then read -r revision < .dev/qa-build-revision; fi
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
for i in "${!images[@]}"; do
  names=(postgres login)
  remote="$registry-${names[$i]}:$revision"
  if [[ "$1" == publish ]]; then
    docker tag "${images[$i]}" "$remote"
    docker push "$remote"
  else
    docker pull "$remote"
    docker tag "$remote" "${images[$i]}"
  fi
done
