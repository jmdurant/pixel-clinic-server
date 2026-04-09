#!/usr/bin/env bash
#
# clinic-dev.sh — fire pixel clinic dev events at the local clinic-dashboard server
#
# Used for Quest 3D renderer development (and any other client that subscribes
# to the Mac hub) when you want to fast-iterate on animations or NPC behavior
# without running a full clinical visit on the iPhone.
#
# Usage:
#   ./clinic-dev.sh                          # show help
#   ./clinic-dev.sh visit                    # run a full visit choreography
#   ./clinic-dev.sh patient_to_exam          # fire one named flow action
#   ./clinic-dev.sh move intern cr-chair-visitor  # fire a direct agent move
#   ./clinic-dev.sh status intern thinking "Reviewing labs"  # fire activity event
#   ./clinic-dev.sh reset                    # send all agents back to default seats
#
# Override the hub URL with: PIXEL_CLINIC_HUB=http://other-mac.local:3456 ./clinic-dev.sh ...

set -euo pipefail

HUB="${PIXEL_CLINIC_HUB:-http://localhost:3456}"
SLEEP_BETWEEN="${CLINIC_DEV_SLEEP:-2}"

# All 12 named flow actions the server knows about
FLOWS=(
  patient_to_exam
  patient_to_therapy
  patient_to_nurse
  patient_to_exit
  intern_to_chief_resident
  intern_to_attending
  intern_return
  chief_resident_to_attending
  chief_resident_to_patient
  chief_resident_return
  attending_to_patient
  attending_return
)

# 10 named agents (matches CLINIC_AGENT_NAMES on the server)
AGENTS=(receptionist intern chief_resident attending admin therapist nurse hr it patient)

# Default seat for an agent (case statement instead of `declare -A` so this
# works with macOS's bundled Bash 3.2 — no GPL3 upgrade required).
default_seat_for() {
  case "$1" in
    receptionist)   echo recep-chair ;;
    intern)         echo exam1-chair-doc ;;
    chief_resident) echo cr-chair ;;
    attending)      echo att-chair ;;
    admin)          echo admin-chair ;;
    therapist)      echo therapy-chair-2 ;;
    nurse)          echo nurse-chair ;;
    hr)             echo hr-chair ;;
    it)             echo it-chair ;;
    patient)        echo entry-chair-patient ;;
    *)              echo "" ;;
  esac
}

post_json() {
  local endpoint="$1" body="$2"
  curl -sS -X POST "$HUB$endpoint" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    || { echo "✗ Failed to POST $endpoint" >&2; exit 1; }
  echo
}

fire_flow() {
  local action="$1"
  echo "→ flow: $action"
  post_json /api/clinic/flow "{\"action\":\"$action\"}"
}

fire_move() {
  local agent="$1" seat="$2"
  echo "→ move: $agent → $seat"
  post_json /api/clinic/move "{\"agent\":\"$agent\",\"seatId\":\"$seat\"}"
}

fire_event() {
  local agent="$1" status="$2" task="${3:-}"
  if [ -n "$task" ]; then
    echo "→ event: $agent = $status ($task)"
    post_json /api/event "{\"agent\":\"$agent\",\"status\":\"$status\",\"task\":\"$task\"}"
  else
    echo "→ event: $agent = $status"
    post_json /api/event "{\"agent\":\"$agent\",\"status\":\"$status\"}"
  fi
}

run_visit() {
  echo "── full visit choreography ──"
  fire_flow patient_to_exam
  fire_event intern thinking "Taking history"
  sleep "$SLEEP_BETWEEN"

  fire_flow intern_to_chief_resident
  fire_event chief_resident thinking "Reviewing presentation"
  sleep "$SLEEP_BETWEEN"

  fire_flow chief_resident_to_attending
  fire_event attending thinking "Reviewing CR's recommendation"
  sleep "$SLEEP_BETWEEN"

  fire_flow chief_resident_return
  fire_flow intern_return
  fire_event intern talking "Sharing plan with patient"
  sleep "$SLEEP_BETWEEN"

  fire_flow patient_to_exit
  fire_event intern idle
  fire_event chief_resident idle
  echo "── visit complete ──"
}

reset_all() {
  echo "── reset: send all agents to default seats ──"
  for agent in "${AGENTS[@]}"; do
    fire_move "$agent" "$(default_seat_for "$agent")"
  done
  for agent in "${AGENTS[@]}"; do
    fire_event "$agent" idle
  done
}

show_help() {
  cat <<EOF
clinic-dev — fire pixel clinic dev events at $HUB

Commands:
  visit                          Run a full visit choreography (12-15s)
  reset                          Send all agents back to their default seats

  <flow_action>                  Fire one of the 12 named flow actions:
                                   ${FLOWS[*]}

  move <agent> <seat>            Fire a direct agent move
                                   agents: ${AGENTS[*]}

  status <agent> <status> [task] Fire an activity event
                                   status: thinking | talking | idle
                                   task:   optional speech bubble text

Environment:
  PIXEL_CLINIC_HUB    Hub URL (default: http://localhost:3456)
  CLINIC_DEV_SLEEP    Seconds between sequence steps (default: 2)

Examples:
  ./clinic-dev.sh visit
  ./clinic-dev.sh patient_to_exam
  ./clinic-dev.sh move nurse exam1-chair-doc
  ./clinic-dev.sh status chief_resident thinking "Reviewing labs"
  ./clinic-dev.sh reset
EOF
}

# Argument routing
case "${1:-}" in
  ""|help|-h|--help)
    show_help
    ;;
  visit)
    run_visit
    ;;
  reset)
    reset_all
    ;;
  move)
    [ $# -ge 3 ] || { echo "usage: $0 move <agent> <seat>" >&2; exit 1; }
    fire_move "$2" "$3"
    ;;
  status)
    [ $# -ge 3 ] || { echo "usage: $0 status <agent> <status> [task]" >&2; exit 1; }
    fire_event "$2" "$3" "${4:-}"
    ;;
  *)
    # Treat as a flow action — validate against known flows
    found=0
    for f in "${FLOWS[@]}"; do
      if [ "$f" = "$1" ]; then found=1; break; fi
    done
    if [ "$found" -eq 1 ]; then
      fire_flow "$1"
    else
      echo "✗ Unknown command or flow action: $1" >&2
      echo >&2
      show_help >&2
      exit 1
    fi
    ;;
esac
