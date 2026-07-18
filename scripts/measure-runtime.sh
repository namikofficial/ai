#!/usr/bin/env bash
set -euo pipefail

api_url="${AI_API_URL:-http://127.0.0.1:${AI_API_PORT:-4417}}"
cache_path="${AI_PROJECT_STATUS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/ai-workbench/project-status-v1.json}"
samples="${AI_PERFORMANCE_SAMPLES:-25}"

if ! [[ "$samples" =~ ^[0-9]+$ ]] || ((samples < 1 || samples > 1000)); then
  printf 'AI_PERFORMANCE_SAMPLES must be an integer from 1 to 1000\n' >&2
  exit 2
fi

command -v curl >/dev/null 2>&1 || { printf 'curl is required\n' >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { printf 'jq is required\n' >&2; exit 2; }

now_ms() {
  date +%s%3N
}

median() {
  sort -n | awk '{values[NR]=$1} END {if (NR == 0) print "null"; else if (NR % 2) print values[(NR+1)/2]; else printf "%.3f", (values[NR/2]+values[NR/2+1])/2}'
}

http_latency_ms() {
  local path="$1" result
  result="$(curl --silent --output /dev/null --max-time 2 --write-out '%{http_code} %{time_total}' "${api_url%/}${path}" 2>/dev/null || true)"
  awk '$1 >= 200 && $1 < 300 {printf "%.3f", $2 * 1000}' <<<"$result"
}

cache_samples=()
cache_valid=false
cache_bytes=0
if [[ -r "$cache_path" ]] && jq -e '.schemaVersion == 1' "$cache_path" >/dev/null 2>&1; then
  cache_valid=true
  cache_bytes="$(stat -c '%s' "$cache_path")"
  for ((sample = 0; sample < samples; sample += 1)); do
    started="$(now_ms)"
    <"$cache_path" jq -e '.compact.schemaVersion == 1' >/dev/null
    cache_samples+=("$(( $(now_ms) - started ))")
  done
fi
cache_median="$(printf '%s\n' "${cache_samples[@]:-}" | sed '/^$/d' | median)"

ready_samples=()
status_samples=()
for ((sample = 0; sample < samples; sample += 1)); do
  value="$(http_latency_ms /ready)"
  [[ -n "$value" ]] && ready_samples+=("$value")
  value="$(http_latency_ms /project-status/compact)"
  [[ -n "$value" ]] && status_samples+=("$value")
done
ready_median="$(printf '%s\n' "${ready_samples[@]:-}" | sed '/^$/d' | median)"
status_median="$(printf '%s\n' "${status_samples[@]:-}" | sed '/^$/d' | median)"

service_pid="${AI_WORKBENCH_PID:-0}"
if [[ "$service_pid" == "0" ]] && command -v systemctl >/dev/null 2>&1; then
  service_pid="$(systemctl --user show ai-workbench.service --property MainPID --value 2>/dev/null || printf '0')"
fi
[[ "$service_pid" =~ ^[0-9]+$ ]] || service_pid=0

rss_kib=null
idle_cpu_percent=null
if ((service_pid > 1)) && [[ -r "/proc/$service_pid/stat" ]]; then
  rss_kib="$(awk '/^VmRSS:/ {print $2; exit}' "/proc/$service_pid/status" 2>/dev/null || true)"
  [[ "$rss_kib" =~ ^[0-9]+$ ]] || rss_kib=null
  stat_before="$(<"/proc/$service_pid/stat")"
  rest_before="${stat_before##*) }"
  read -ra fields_before <<<"$rest_before"
  ticks_before="$(( fields_before[11] + fields_before[12] ))"
  sleep 1
  if [[ -r "/proc/$service_pid/stat" ]]; then
    stat_after="$(<"/proc/$service_pid/stat")"
    rest_after="${stat_after##*) }"
    read -ra fields_after <<<"$rest_after"
    ticks_after="$(( fields_after[11] + fields_after[12] ))"
    clock_ticks="$(getconf CLK_TCK)"
    idle_cpu_percent="$(awk -v delta="$((ticks_after - ticks_before))" -v hz="$clock_ticks" 'BEGIN {printf "%.3f", (delta / hz) * 100}')"
  fi
fi

jq -n \
  --arg measuredAt "$(date --iso-8601=ns)" \
  --arg apiUrl "$api_url" \
  --arg cachePath "$cache_path" \
  --argjson sampleCount "$samples" \
  --argjson apiReady "$([[ ${#ready_samples[@]} -gt 0 ]] && printf true || printf false)" \
  --argjson readyLatencyMs "$ready_median" \
  --argjson statusLatencyMs "$status_median" \
  --argjson cacheValid "$cache_valid" \
  --argjson cacheBytes "$cache_bytes" \
  --argjson cacheReadLatencyMs "$cache_median" \
  --argjson servicePid "$service_pid" \
  --argjson idleCpuPercent "$idle_cpu_percent" \
  --argjson rssKiB "$rss_kib" \
  '{schemaVersion:1,measuredAt:$measuredAt,sampleCount:$sampleCount,api:{url:$apiUrl,ready:$apiReady,readyLatencyMedianMs:$readyLatencyMs,statusLatencyMedianMs:$statusLatencyMs},cache:{path:$cachePath,valid:$cacheValid,bytes:$cacheBytes,readLatencyMedianMs:$cacheReadLatencyMs},process:{pid:(if $servicePid > 1 then $servicePid else null end),idleCpuPercent:$idleCpuPercent,rssKiB:$rssKiB}}'
