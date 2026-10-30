#!/usr/bin/env bash
# Runs Danlex's Lullaby in GZDoom, with the base game it needs.
#
# Lullaby is not a standalone game: it is a Doom 2 mapset shipped as a PK3 that needs
# GZDoom to read its UDMF maps (`Lullaby/Lullaby.TXT`: "Advanced engine needed: GZDoom",
# "Game: Doom 2", "May Not Run With: Old versions of GZDoom", tested on 4.3.3 / 4.5.0 /
# 4.10.0). So this launches `gzdoom -iwad Doom2.wad -file Lullaby.pk3`: Doom 2 for the
# resources, Lullaby for everything the maps are made of.
#
#   ./Lullaby.sh                      # title map, then the menu - the way it is meant to start
#   ./Lullaby.sh -warp 1              # straight into MAP01
#   ./Lullaby.sh -warp 2 -skill 4     # MAP02 on nightmare
#   ./Lullaby.sh -fast                # monsters are awake and moving from the start
#   GZDOOM_IWAD=~/wads/DOOM2.WAD ./Lullaby.sh
#   GZDOOM=~/gzdoom/gzdoom ./Lullaby.sh
#
# Everything you pass is passed to GZDoom, exactly like ./GZDoom.sh. The difference is the
# mod: it is always loaded, and it is loaded last so it wins over the IWAD's lumps.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dist="$root/tools/gzdoom/dist"

# Where the PK3 lives. The repository keeps a copy under Projects/Lullaby/; point
# GZDOOM_LULLABY at your own download instead if that copy is not there.
pk3="${GZDOOM_LULLABY:-}"
if [[ -z "$pk3" ]]; then
  for candidate in "$root/Projects/Lullaby/Lullaby.pk3" "$root/Projects/Lullaby.pk3"; do
    if [[ -f "$candidate" ]]; then pk3="$candidate"; break; fi
  done
fi
if [[ ! -f "$pk3" ]]; then
  echo "No Lullaby.pk3 found." >&2
  echo "Put it at Projects/Lullaby/Lullaby.pk3 or run this with GZDOOM_LULLABY=/path/to/Lullaby.pk3" >&2
  exit 1
fi

# Lullaby is a Doom 2 mod. Freedoom's second WAD is the closest free stand-in if the real
# IWAD is missing, but it is not what the map was tested with, so it is named as a fallback
# rather than used silently.
iwad="${GZDOOM_IWAD:-$root/Projects/Doom2.wad}"
fallback_iwad="$root/Projects/freedoom2.wad"
caller_chose_iwad=false
for arg in "$@"; do [[ "$arg" == "-iwad" ]] && caller_chose_iwad=true; done
if ! $caller_chose_iwad; then
  if [[ ! -f "$iwad" ]]; then
    if [[ -f "$fallback_iwad" ]]; then
      echo "No Doom 2 IWAD at $iwad - using Freedoom Phase 2, which Lullaby is not tested with." >&2
      iwad="$fallback_iwad"
    else
      echo "No IWAD at $iwad - pass one with -iwad, or set GZDOOM_IWAD." >&2
      exit 1
    fi
  fi
fi

binary="${GZDOOM:-}"
if [[ -z "$binary" ]]; then
  if [[ -x "$dist/gzdoom" ]]; then binary="$dist/gzdoom"
  elif command -v gzdoom >/dev/null 2>&1; then binary="$(command -v gzdoom)"
  else
    echo "No GZDoom found. Install the pinned build with: npm run gzdoom:fetch" >&2
    echo "(or run this with GZDOOM=/path/to/gzdoom)" >&2
    exit 1
  fi
fi

# Same runtime plumbing as ./GZDoom.sh: GZDoom links a libbz2 soname recent distributions
# no longer ship, and its own libzmusic lives beside the binary.
if [[ -d "$dist/lib" || -f "$dist/libzmusic.so.1" ]]; then
  export LD_LIBRARY_PATH="$dist/lib:$dist${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# Lullaby needs GZDoom 4.x: its maps are UDMF and it uses features older builds do not
# have. Warn instead of refusing, because a newer build than this check knows about is
# perfectly fine.
version="$("$binary" -version 2>/dev/null | head -1 || true)"
if [[ "$version" =~ ([0-9]+)\.[0-9]+ ]]; then
  if (( BASH_REMATCH[1] < 4 )); then
    echo "GZDoom here reports '$version'; Lullaby needs 4.3.3 or newer and will fail to load its maps." >&2
  fi
fi

extra=()
if [[ -x "$dist/gzdoom" && "$binary" == "$dist/gzdoom" ]]; then
  extra=(-basedir "$dist")
fi

# The arrow keys are unbound in GZDoom's stock layout; the same bindings ./GZDoom.sh uses.
bind_files=()
if [[ -z "${GZDOOM_KEEP_KEYS:-}" ]]; then
  [[ -f "$root/tools/gzdoom/controls.cfg" ]] && bind_files=(-exec "$root/tools/gzdoom/controls.cfg")
fi

args=("${extra[@]}" "${bind_files[@]}")
$caller_chose_iwad || args+=(-iwad "$iwad")
args+=(-file "$pk3" "$@")

if [[ -z "${GZDOOM_QUIET:-}" ]]; then
  echo "Lullaby: Danlex's Doom 2 PK3 (MAP01-02, UDMF) on GZDoom."
  echo "  iwad  $(basename -- "$iwad")"
  echo "  mod   $pk3"
  echo "Controls are GZDoom's: WASD/arrows move, Space jump, E use, mouse1 fire, Tab automap."
  echo "Add -warp 1 to skip the title, -skill 4 for nightmare. Anything you pass goes to GZDoom."
  echo
fi

exec "$binary" "${args[@]}"
