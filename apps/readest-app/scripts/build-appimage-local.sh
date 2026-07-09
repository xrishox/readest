#!/usr/bin/env bash
# Build a working Readest AppImage on a local rolling-release box (Arch
# container / Bazzite host). The stock `pnpm tauri build` AppImage is broken
# here in several ways, all packaging-level (see docs/appimage-local-build.md
# for the full post-mortem):
#
#   1. linuxdeploy's bundled `strip` chokes on .relr.dyn sections   -> NO_STRIP=1
#   2. linuxdeploy's patchelf pass corrupts libleancrypto.so.1      -> restore system copy
#   3. WebKitGTK's DMABUF renderer renders nothing on NVIDIA        -> env hook
#   4. GStreamer core is bundled without its plugin dir, so Web
#      Audio (TTS) hangs the WebProcess                             -> bundle plugins + env hook
#   5. gdk-pixbuf loader modules (legacy hosts only; glycin hosts
#      delegate to host loaders)                                    -> conditional bundle + gate
#   6. the in-app updater would replace this repaired AppImage
#      with the official release build                              -> env hook (opt back in
#                                                                      with READEST_DISABLE_UPDATER=0)
#
# Integrity gates run before repack so a regression in any of the above fails
# the build instead of surfacing as a runtime mystery.
#
# Usage: scripts/build-appimage-local.sh [--skip-build] [--fast]
#   --skip-build  repackage the existing bundle without recompiling
#   --fast        skip the ~2 min dlopen/ldd sweeps (cheap asserts still run)

set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
BUNDLE_DIR="$REPO_ROOT/target/release/bundle/appimage"
GST_GOOD_URL="${GST_GOOD_URL:-https://archlinux.org/packages/extra/x86_64/gst-plugins-good/download/}"
GST_GOOD_ARCHIVE="https://archive.archlinux.org/packages/g/gst-plugins-good"

SKIP_BUILD=0 FAST=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --fast)       FAST=1 ;;
    *) echo "usage: $0 [--skip-build] [--fast]" >&2; exit 1 ;;
  esac
done

command -v appimagetool >/dev/null || { echo "error: appimagetool not found in PATH" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "error: pnpm not found in PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 required for build gates" >&2; exit 1; }

if [[ "$SKIP_BUILD" != 1 ]]; then
  # Tauri exits non-zero after bundling when TAURI_SIGNING_PRIVATE_KEY is
  # unset; the AppImage is already complete at that point, so only the
  # artifact's existence below decides success.
  NO_STRIP=1 pnpm --dir "$REPO_ROOT" tauri build --bundles appimage || true
fi

APPIMAGE=$(ls -t "$BUNDLE_DIR"/Readest_*.AppImage 2>/dev/null | head -1 || true)
[[ -n "$APPIMAGE" ]] || { echo "error: no AppImage found in $BUNDLE_DIR" >&2; exit 1; }
echo "==> repairing $(basename "$APPIMAGE")"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
"$APPIMAGE" --appimage-extract >/dev/null
APPDIR="$WORK/squashfs-root"
LIB="$APPDIR/usr/lib"

# --- fix 2: patchelf-corrupted libleancrypto (segfault in ld.so on launch) --
if [[ -e /usr/lib/libleancrypto.so.1 ]]; then
  cp /usr/lib/libleancrypto.so.1 "$LIB/libleancrypto.so.1"
elif [[ -e "$LIB/libleancrypto.so.1" ]]; then
  # No system copy to restore: drop the corrupted one and let the loader
  # resolve it from the host at runtime.
  rm "$LIB/libleancrypto.so.1"
fi

# --- fix 4: bundle the GStreamer plugins the bundled core can discover ------
# GStreamer resolves its plugin dir relative to libgstreamer's own location,
# so the bundled core sees an empty plugin set unless the dir exists next to
# it (the env hook below pins it explicitly as well).
mkdir -p "$LIB/gstreamer-1.0"
cp /usr/lib/gstreamer-1.0/*.so "$LIB/gstreamer-1.0/"
cp /usr/lib/gstreamer-1.0/gst-plugin-scanner "$LIB/gstreamer-1.0/"

# Host plugins only register against a core of the same major.minor, so a
# --skip-build re-repair after a host gstreamer upgrade would silently bundle
# unloadable plugins — hard-fail instead.
pkginfo_ver() { bsdtar -xOf "$1" .PKGINFO | sed -n 's/^pkgver = //p'; }
# No grep -m1/head here: an early-exiting pipe reader SIGPIPEs `strings` and,
# under pipefail, silently kills the whole script with exit 141.
core_matches=$(strings "$LIB/libgstreamer-1.0.so.0" | grep -oE 'GStreamer 1\.[0-9]+\.[0-9]+' || true)
bundled_core=${core_matches%%$'\n'*}; bundled_core=${bundled_core#GStreamer }
host_core=$(pacman -Q gstreamer 2>/dev/null | awk '{print $2}' || true); host_core=${host_core%-*}
if [[ -z "$host_core" ]]; then
  echo "warning: pacman not available; skipping GStreamer version guard" >&2
elif [[ -n "$bundled_core" && "${bundled_core%.*}" != "${host_core%.*}" ]]; then
  echo "error: bundled GStreamer core $bundled_core != host $host_core;" \
       "host plugins won't register — re-run without --skip-build" >&2
  exit 1
fi

# wavparse (WAV decode), autodetect and pulseaudio (output) are required for
# Web Audio / TTS but come from gst-plugins-good, which the build container
# doesn't install. Fetch the Arch package only when they're missing, and pin
# it to the installed gstreamer version (a rolling-repo download can drift
# ahead of the frozen bundled core).
if [[ ! -e "$LIB/gstreamer-1.0/libgstwavparse.so" ]]; then
  echo "==> fetching gst-plugins-good for wavparse/autodetect/pulseaudio"
  curl -fsSL -o "$WORK/gst-good.pkg.tar.zst" "$GST_GOOD_URL"
  good_ver=$(pkginfo_ver "$WORK/gst-good.pkg.tar.zst")
  if [[ -n "$host_core" && "${good_ver%-*}" != "$host_core" ]]; then
    echo "==> gst-plugins-good $good_ver drifted from installed gstreamer $host_core; using archive"
    listing=$(curl -fsSL "$GST_GOOD_ARCHIVE/")
    pkg=$(grep -oE "gst-plugins-good-${host_core//./\\.}-[0-9]+-x86_64\.pkg\.tar\.(zst|xz)" <<<"$listing" | sort -uV | tail -1 || true)
    if [[ -z "$pkg" ]]; then
      echo "error: no gst-plugins-good $host_core on $GST_GOOD_ARCHIVE —" \
           "install it via 'pacman -S gst-plugins-good' and re-run" >&2
      exit 1
    fi
    curl -fsSL -o "$WORK/gst-good.pkg.tar.zst" "$GST_GOOD_ARCHIVE/$pkg"
    good_ver=$(pkginfo_ver "$WORK/gst-good.pkg.tar.zst")
    [[ "${good_ver%-*}" == "$host_core" ]] || { echo "error: archive gave $good_ver, wanted $host_core" >&2; exit 1; }
  fi
  bsdtar -xf "$WORK/gst-good.pkg.tar.zst" -C "$WORK" usr/lib/gstreamer-1.0
  cp "$WORK/usr/lib/gstreamer-1.0/"*.so "$LIB/gstreamer-1.0/"
fi

# ASCII-art sinks and wavpack depend on libs neither bundled nor guaranteed on
# the host; gst would skip them anyway, dropping them keeps the registry clean.
rm -f "$LIB/gstreamer-1.0/"libgst{aasink,cacasink,wavpack}.so

# pulsesink's own deps, in case the runtime container lacks pulse client libs.
cp /usr/lib/libpulse.so.0 "$LIB/"
cp /usr/lib/pulseaudio/libpulsecommon-*.so "$LIB/"

# --- fix 5: gdk-pixbuf loaders ----------------------------------------------
# gdk-pixbuf >= 2.44 on Arch ships zero legacy loader modules (decoding is
# delegated to out-of-process glycin loaders found on the *host* via
# XDG_DATA_DIRS), so the bundled header-only loaders.cache is faithful and
# this branch stays dormant. On hosts that still have legacy loaders, bundle
# them with a relocatable (basename-relative) cache. Either way the decode
# gate below proves image loading works before repack.
PB_HOST=/usr/lib/gdk-pixbuf-2.0/2.10.0
PB_DIR="$LIB/gdk-pixbuf-2.0/2.10.0"
PIXBUF_BUNDLED=0
if compgen -G "$PB_HOST/loaders/*.so" >/dev/null; then
  mkdir -p "$PB_DIR/loaders"
  cp "$PB_HOST"/loaders/*.so "$PB_DIR/loaders/"
  # query-loaders emits absolute host paths; strip to basenames so the cache
  # relocates, and let GDK_PIXBUF_MODULEDIR (hook, below) resolve them.
  gdk-pixbuf-query-loaders "$PB_HOST"/loaders/*.so \
    | sed -E 's|^"[^"]*/([^/"]+\.so)"|"\1"|' > "$PB_DIR/loaders.cache"
  grep -q '^"' "$PB_DIR/loaders.cache" || { echo "error: generated loaders.cache is empty" >&2; exit 1; }
  PIXBUF_BUNDLED=1
fi

# --- fixes 3 + 4 + 6: runtime env exported by the AppRun GTK hook -----------
# Sed ordering is load-bearing: the DMABUF/GST injection anchors on the
# original `export GDK_BACKEND=x11` line, so it must run before the
# GDK_BACKEND rewrite; new env goes in one appended marker-guarded block.
HOOK="$APPDIR/apprun-hooks/linuxdeploy-plugin-gtk.sh"
if ! grep -q WEBKIT_DISABLE_DMABUF_RENDERER "$HOOK"; then
  sed -i '/^export GDK_BACKEND=x11/a \
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}" # blank webview with DMABUF renderer on NVIDIA\
export GST_PLUGIN_SYSTEM_PATH_1_0="$APPDIR/usr/lib/gstreamer-1.0" # bundled gst core has no plugin dir of its own\
export GST_PLUGIN_SCANNER="$APPDIR/usr/lib/gstreamer-1.0/gst-plugin-scanner"' "$HOOK"
fi

# Prefer native Wayland. The linuxdeploy hook pins X11 over a GTK-on-Wayland
# crash (tauri#8541) that does not reproduce with this bundle (verified on
# KDE Plasma Wayland). A user-provided GDK_BACKEND still wins.
sed -i 's|^export GDK_BACKEND=x11 .*|export GDK_BACKEND="${GDK_BACKEND:-wayland,x11}" # native Wayland first; linuxdeploy pinned x11 for tauri#8541, not reproducible here|' "$HOOK"

# Bundled GTK modules only; the stock hook appends host module dirs, which
# invites GTK version skew on rolling hosts.
sed -i 's|^export GTK_PATH=.*|export GTK_PATH="$APPDIR/usr/lib/gtk-3.0"|' "$HOOK"

if ! grep -q 'readest-local-build' "$HOOK"; then
  {
    cat <<'EOF'

# readest-local-build additions
# The in-app updater would replace this repaired AppImage with the official
# release build. The Rust side treats the mere PRESENCE of
# READEST_DISABLE_UPDATER as "disabled" (value ignored), so opting back in
# requires launching with READEST_DISABLE_UPDATER=0 (translated to unset
# here). This block must never fail: the hook is sourced under `set -e`.
if [ "${READEST_DISABLE_UPDATER:-1}" != "0" ]; then
    export READEST_DISABLE_UPDATER=1
else
    unset READEST_DISABLE_UPDATER
fi
EOF
    if [[ "$PIXBUF_BUNDLED" == 1 ]]; then
      echo 'export GDK_PIXBUF_MODULEDIR="$APPDIR/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders" # resolve basename-relative cache entries'
    fi
  } >> "$HOOK"
fi

# --- gates: fail before repack, not at runtime -------------------------------
SWEEP_PATH="$LIB:$LIB/gstreamer-1.0"

if [[ "$FAST" != 1 ]]; then
  # This is the sweep that would have caught the corrupted libleancrypto.
  echo "==> gate: dlopen sweep (~2 min; --fast skips)"
  fails=()
  while IFS= read -r -d '' so; do
    timeout 10 env LD_LIBRARY_PATH="$SWEEP_PATH" \
      python3 -c 'import ctypes,sys; ctypes.CDLL(sys.argv[1])' "$so" >/dev/null 2>&1 \
      || fails+=("$so")
  done < <(find "$LIB" -name '*.so*' -type f -print0)
  ((${#fails[@]} == 0)) || { printf 'error: dlopen failed for:\n  %s\n' "${fails[@]}" >&2; exit 1; }

  echo "==> gate: ldd sweep"
  missing=$(
    { find "$LIB" -name '*.so*' -type f -print0
      printf '%s\0' "$APPDIR"/usr/bin/* "$LIB"/webkit2gtk-4.1/WebKit*; } |
    while IFS= read -r -d '' f; do
      head -c4 "$f" | grep -q $'\x7fELF' || continue  # xdg-mime/xdg-open are scripts
      # `|| true`: grep exits 1 for the (expected) no-unresolved case, which
      # set -e would otherwise turn into an aborted, vacuously-passing sweep.
      env LD_LIBRARY_PATH="$SWEEP_PATH" ldd "$f" 2>/dev/null | grep 'not found' | sed "s|^|$f: |" || true
    done
  )
  [[ -z "$missing" ]] || { printf 'error: unresolved libraries:\n%s\n' "$missing" >&2; exit 1; }
fi

echo "==> gate: hook env + gst inventory"
for needle in WEBKIT_DISABLE_DMABUF_RENDERER GST_PLUGIN_SYSTEM_PATH_1_0 GST_PLUGIN_SCANNER \
              READEST_DISABLE_UPDATER 'GDK_BACKEND="${GDK_BACKEND:-wayland,x11}"' \
              'GTK_PATH="$APPDIR/usr/lib/gtk-3.0"'; do
  grep -qF "$needle" "$HOOK" || { echo "error: hook missing: $needle" >&2; exit 1; }
done
nplugins=$(find "$LIB/gstreamer-1.0" -name 'libgst*.so' | wc -l)
(( nplugins > 200 )) || { echo "error: only $nplugins gst plugins bundled (expected >200 — is gst-plugins-base installed?)" >&2; exit 1; }
for p in wavparse autodetect pulseaudio mpg123; do
  [[ -e "$LIB/gstreamer-1.0/libgst$p.so" ]] || { echo "error: libgst$p.so missing" >&2; exit 1; }
done

echo "==> gate: pixbuf decode through the bundled stack"
if python3 -c 'import gi' 2>/dev/null; then
  icon=$(find "$APPDIR" -maxdepth 1 -name '*.png' | head -1 || true)
  pixbuf_env=(XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share"
    GDK_PIXBUF_MODULE_FILE="$PB_DIR/loaders.cache" LD_LIBRARY_PATH="$LIB")
  [[ "$PIXBUF_BUNDLED" == 1 ]] && pixbuf_env+=(GDK_PIXBUF_MODULEDIR="$PB_DIR/loaders")
  timeout 20 env "${pixbuf_env[@]}" python3 -B -c "
import gi; gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf
GdkPixbuf.Pixbuf.new_from_file('$icon')" \
    || { echo "error: bundled gdk-pixbuf stack cannot decode PNG (host glycin missing?)" >&2; exit 1; }
else
  echo "warning: python-gobject not installed; skipping pixbuf decode gate" >&2
fi

# --- repack -----------------------------------------------------------------
OUT="$WORK/$(basename "$APPIMAGE")"
ARCH=x86_64 appimagetool "$APPDIR" "$OUT" > "$WORK/appimagetool.log" 2>&1 \
  || { cat "$WORK/appimagetool.log" >&2; echo "error: appimagetool failed" >&2; exit 1; }
# rm+cp replaces the inode, so this works even while an old copy is running.
rm -f "$APPIMAGE"
cp "$OUT" "$APPIMAGE"
chmod +x "$APPIMAGE"
echo "==> done: $APPIMAGE"
