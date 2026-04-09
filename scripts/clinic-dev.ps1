# clinic-dev.ps1 — fire pixel clinic dev events at the local clinic-dashboard server
#
# Used for Quest 3D renderer development (and any other client that subscribes
# to the Mac hub) when you want to fast-iterate on animations or NPC behavior
# without running a full clinical visit on the iPhone.
#
# Usage:
#   .\clinic-dev.ps1                                # show help
#   .\clinic-dev.ps1 visit                          # run a full visit choreography
#   .\clinic-dev.ps1 patient_to_exam                # fire one named flow action
#   .\clinic-dev.ps1 move intern cr-chair-visitor   # fire a direct agent move
#   .\clinic-dev.ps1 status intern thinking "Reviewing labs"  # fire activity event
#   .\clinic-dev.ps1 reset                          # send all agents to default seats
#
# Override the hub URL with: $env:PIXEL_CLINIC_HUB = "http://other-mac.local:3456"

[CmdletBinding()]
param(
    [Parameter(Position = 0)] [string]$Command,
    [Parameter(Position = 1)] [string]$Arg1,
    [Parameter(Position = 2)] [string]$Arg2,
    [Parameter(Position = 3)] [string]$Arg3
)

$ErrorActionPreference = 'Stop'

$Hub = if ($env:PIXEL_CLINIC_HUB) { $env:PIXEL_CLINIC_HUB } else { 'http://localhost:3456' }
$SleepBetween = if ($env:CLINIC_DEV_SLEEP) { [int]$env:CLINIC_DEV_SLEEP } else { 2 }

# All 12 named flow actions the server knows about
$Flows = @(
    'patient_to_exam', 'patient_to_therapy', 'patient_to_nurse', 'patient_to_exit',
    'intern_to_chief_resident', 'intern_to_attending', 'intern_return',
    'chief_resident_to_attending', 'chief_resident_to_patient', 'chief_resident_return',
    'attending_to_patient', 'attending_return'
)

# 8 named agents (matches CLINIC_AGENT_NAMES on the server)
$Agents = @('receptionist', 'intern', 'chief_resident', 'attending', 'admin', 'therapist', 'nurse', 'patient', 'hr', 'it')

# Default seats by agent (matches CLINIC_SEATS on the server)
$DefaultSeats = @{
    receptionist   = 'recep-chair'
    intern         = 'exam1-chair-doc'
    chief_resident = 'cr-chair'
    attending      = 'att-chair'
    admin          = 'admin-chair'
    therapist      = 'therapy-chair-2'
    nurse          = 'nurse-chair'
    hr             = 'hr-chair'
    it             = 'it-chair'
    patient        = 'entry-chair-patient'
}

function Post-Json {
    param($Endpoint, $Body)
    try {
        Invoke-RestMethod -Uri ($Hub + $Endpoint) -Method Post `
            -ContentType 'application/json' `
            -Body $Body | Out-Null
    } catch {
        Write-Error "Failed to POST $Endpoint : $_"
        exit 1
    }
}

function Fire-Flow {
    param($Action)
    Write-Host "→ flow: $Action"
    Post-Json -Endpoint '/api/clinic/flow' -Body (@{ action = $Action } | ConvertTo-Json -Compress)
}

function Fire-Move {
    param($Agent, $Seat)
    Write-Host "→ move: $Agent → $Seat"
    Post-Json -Endpoint '/api/clinic/move' -Body (@{ agent = $Agent; seatId = $Seat } | ConvertTo-Json -Compress)
}

function Fire-Event {
    param($Agent, $Status, $Task)
    if ($Task) {
        Write-Host "→ event: $Agent = $Status ($Task)"
        Post-Json -Endpoint '/api/event' -Body (@{ agent = $Agent; status = $Status; task = $Task } | ConvertTo-Json -Compress)
    } else {
        Write-Host "→ event: $Agent = $Status"
        Post-Json -Endpoint '/api/event' -Body (@{ agent = $Agent; status = $Status } | ConvertTo-Json -Compress)
    }
}

function Run-Visit {
    Write-Host "── full visit choreography ──"
    Fire-Flow 'patient_to_exam'
    Fire-Event 'intern' 'thinking' 'Taking history'
    Start-Sleep -Seconds $SleepBetween

    Fire-Flow 'intern_to_chief_resident'
    Fire-Event 'chief_resident' 'thinking' 'Reviewing presentation'
    Start-Sleep -Seconds $SleepBetween

    Fire-Flow 'chief_resident_to_attending'
    Fire-Event 'attending' 'thinking' 'Reviewing CR''s recommendation'
    Start-Sleep -Seconds $SleepBetween

    Fire-Flow 'chief_resident_return'
    Fire-Flow 'intern_return'
    Fire-Event 'intern' 'talking' 'Sharing plan with patient'
    Start-Sleep -Seconds $SleepBetween

    Fire-Flow 'patient_to_exit'
    Fire-Event 'intern' 'idle'
    Fire-Event 'chief_resident' 'idle'
    Write-Host "── visit complete ──"
}

function Reset-All {
    Write-Host "── reset: send all agents to default seats ──"
    foreach ($agent in $Agents) {
        Fire-Move $agent $DefaultSeats[$agent]
    }
    foreach ($agent in $Agents) {
        Fire-Event $agent 'idle'
    }
}

function Show-Help {
    @"
clinic-dev — fire pixel clinic dev events at $Hub

Commands:
  visit                            Run a full visit choreography (12-15s)
  reset                            Send all agents back to their default seats

  <flow_action>                    Fire one of the 12 named flow actions:
                                     $($Flows -join ', ')

  move <agent> <seat>              Fire a direct agent move
                                     agents: $($Agents -join ', ')

  status <agent> <status> [task]   Fire an activity event
                                     status: thinking | talking | idle
                                     task:   optional speech bubble text

Environment:
  PIXEL_CLINIC_HUB     Hub URL (default: http://localhost:3456)
  CLINIC_DEV_SLEEP     Seconds between sequence steps (default: 2)

Examples:
  .\clinic-dev.ps1 visit
  .\clinic-dev.ps1 patient_to_exam
  .\clinic-dev.ps1 move nurse exam1-chair-doc
  .\clinic-dev.ps1 status chief_resident thinking "Reviewing labs"
  .\clinic-dev.ps1 reset
"@
}

# Argument routing
switch -Wildcard ($Command) {
    { -not $_ -or $_ -in @('help', '-h', '--help') } { Show-Help; break }
    'visit' { Run-Visit; break }
    'reset' { Reset-All; break }
    'move' {
        if (-not $Arg1 -or -not $Arg2) {
            Write-Error "usage: clinic-dev.ps1 move <agent> <seat>"
            exit 1
        }
        Fire-Move $Arg1 $Arg2
        break
    }
    'status' {
        if (-not $Arg1 -or -not $Arg2) {
            Write-Error "usage: clinic-dev.ps1 status <agent> <status> [task]"
            exit 1
        }
        Fire-Event $Arg1 $Arg2 $Arg3
        break
    }
    default {
        if ($Flows -contains $Command) {
            Fire-Flow $Command
        } else {
            Write-Error "Unknown command or flow action: $Command"
            Show-Help
            exit 1
        }
    }
}
