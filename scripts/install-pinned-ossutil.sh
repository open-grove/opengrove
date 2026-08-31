#!/usr/bin/env bash
set -euo pipefail

readonly version="2.3.0"
readonly archive_name="ossutil-${version}-linux-amd64.zip"
readonly expected_sha256="3ae4d9fc85a7a6e9f5654d1599766f1a3a42a3692870887b5ae9338d582ef65a"
readonly archive_path="${RUNNER_TEMP:?RUNNER_TEMP is required}/${archive_name}"
readonly install_dir="${RUNNER_TEMP}/ossutil-${version}-linux-amd64"

curl --fail --silent --show-error --location \
  "https://gosspublic.alicdn.com/ossutil/v2/${version}/${archive_name}" \
  --output "${archive_path}"
printf '%s  %s\n' "${expected_sha256}" "${archive_path}" | sha256sum --check
mkdir -p "${install_dir}"
unzip -oq "${archive_path}" -d "${install_dir}"

binary="$(find "${install_dir}" -type f -name ossutil -print -quit)"
test -n "${binary}"
chmod 755 "${binary}"
echo "$(dirname "${binary}")" >> "${GITHUB_PATH:?GITHUB_PATH is required}"
