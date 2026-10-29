#!/usr/bin/env bash
# Runs Doom 2 in GZDoom, normally, with everything under your control.
#
# This is the opposite of `npm run gzdoom:run`: that one drives a scenario through a demo with
# the mouse turned off, its own throwaway config and a trace mod loaded, so a run can be
# compared with OpenDLE. This one is just GZDoom - your config, your saves, mouse look, sound,
# the video settings you last used - and anything you pass to it is passed straight through.
#
#   ./GZDoom.sh                          # Doom 2, whatever GZDoom normally starts with
#   ./GZDoom.sh -warp 1                  # straight to MAP01
#   ./GZDoom.sh -warp 7 -skill 4         # MAP07 on nightmare
#   ./GZDoom.sh -file ~/mods/pk3/foo.pk3 # with a mod
#   ./GZDoom.sh -iwad Projects/freedoom2.wad
#   GZDOOM=... ./GZDoom.sh               # a different gzdoom binary
#
# The binary is the one `npm run gzdoom:fetch` installs into tools/gzdoom/dist. If that is
# missing, a `gzdoom` on your PATH is used instead.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dist="$root/tools/gzdoom/dist"
iwad="${GZDOOM_IWAD:-$root/Projects/Doom2.wad}"

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

args=("$@")

# An -iwad the caller passed wins over the default, so `-iwad` in the arguments is not
# duplicated. `-file` and everything else are passed through untouched.
caller_chose_iwad=false
for arg in "${args[@]}"; do
  [[ "$arg" == "-iwad" ]] && caller_chose_iwad=true
done
if ! $caller_chose_iwad; then
  if [[ -f "$iwad" ]]; then
    args=(-iwad "$iwad" "${args[@]}")
  else
    echo "No IWAD at $iwad - pass one with -iwad, or set GZDOOM_IWAD." >&2
    exit 1
  fi
fi

# GZDoom links libbz2.so.1.0, which recent distributions no longer ship, and its own
# libzmusic lives beside the binary. Both are found through LD_LIBRARY_PATH; the shim is
# created by tools/gzdoom/fetch.mjs, so this only adds the directory if it exists.
if [[ -d "$dist/lib" || -f "$dist/libzmusic.so.1" ]]; then
  export LD_LIBRARY_PATH="$dist/lib:$dist${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# `-basedir` keeps GZDoom's support files (gzdoom.pk3, the lights and brightmaps) next to the
# binary no matter which directory this was launched from. It is only used when the binary is
# the installed one, because a system install knows where its own data is.
extra=()
if [[ -x "$dist/gzdoom" && "$binary" == "$dist/gzdoom" ]]; then
  extra=(-basedir "$dist")
fi

exec "$binary" "${extra[@]}" "${args[@]}"
