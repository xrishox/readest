# Building the AppImage locally (rolling-release Linux)

Use `scripts/build-appimage-local.sh` instead of a bare
`pnpm tauri build --bundles appimage`:

```bash
apps/readest-app/scripts/build-appimage-local.sh                # build + repair + gates
apps/readest-app/scripts/build-appimage-local.sh --skip-build   # repair the existing bundle only
apps/readest-app/scripts/build-appimage-local.sh --fast         # skip the ~2 min sweeps
```

The final artifact lands in `target/release/bundle/appimage/`.

## Why the stock build is broken here

The AppImage toolchain (linuxdeploy) was designed around older Ubuntu CI
images. Building on a rolling-release system (Arch container on a Bazzite
host, NVIDIA GPU) hits packaging-level defects — none of them are bugs in
Readest itself:

| # | Symptom | Cause | Repair |
|---|---------|-------|--------|
| 1 | `failed to run linuxdeploy` during bundling | linuxdeploy's bundled `strip` can't parse `.relr.dyn` sections in modern glibc-era libraries | `NO_STRIP=1` on the build |
| 2 | Instant segfault on launch (in `ld.so`, via `libgiognutls.so`) | linuxdeploy's `patchelf` pass corrupts `libleancrypto.so.1` (hand-written asm, unusual ELF layout) | Restore the system copy after bundling |
| 3 | Window opens but stays a grey/blank box | WebKitGTK's DMABUF renderer produces nothing on this NVIDIA driver; Readest draws all chrome in the webview, so a dead webview looks like a dead app | Export `WEBKIT_DISABLE_DMABUF_RENDERER=1` from the AppRun hook |
| 4 | App freezes white the moment TTS / any Web Audio starts | GStreamer finds its plugin dir relative to `libgstreamer`'s own location; the bundle ships the core libs with no plugin dir, so WebKit builds a null audio pipeline and `decodeAudioData` never resolves, wedging the WebProcess | Bundle the system GStreamer plugins (plus `wavparse`/`autodetect`/`pulseaudio`/`mpg123` etc. from Arch's `gst-plugins-good`) and export `GST_PLUGIN_SYSTEM_PATH_1_0` |
| 5 | GTK-side images (window icon, dialog images) dead if pixbuf loaders are missing or stale | The bundled `loaders.cache` is header-only. On gdk-pixbuf ≥ 2.44 (glycin era) that is *faithful* — decoding is delegated to **host** glycin loaders, so the host must have `glycin` installed. On legacy hosts an empty cache means no loaders at all | Bundle legacy loaders with a basename-relative cache + `GDK_PIXBUF_MODULEDIR` when the host has them (dormant on glycin hosts); always prove decode with a build gate |
| 6 | Accepting the in-app update prompt replaces the local AppImage with the official release (broken here per #1–#4) | AppImage is the only Linux bundle that keeps the updater active; official endpoints + minisign pubkey are baked in and `autoCheckUpdates` defaults to true (24 h interval) | Hook exports `READEST_DISABLE_UPDATER=1`. The Rust side treats the env var's *presence* as "disabled", so the hook translates `READEST_DISABLE_UPDATER=0` → unset — that is the only way to opt back in |

Diagnostics that pin these down, should they regress:

```bash
# 2 — the gnutls GIO module must dlopen cleanly with the bundled libs:
./Readest_*.AppImage --appimage-extract
LD_LIBRARY_PATH=squashfs-root/usr/lib python3 -c \
  "import ctypes; ctypes.CDLL('squashfs-root/usr/lib/gio/modules/libgiognutls.so')"

# 4 — look for this pair in the app's stderr when audio starts:
#   "GStreamer element appsink not found."
#   GLib-GObject-CRITICAL ... invalid (NULL) pointer instance
```

## Build gates

Before repacking, the script fails the build (instead of leaving a runtime
mystery) if:

- any bundled `.so` fails to `dlopen` under the bundle's `LD_LIBRARY_PATH`
  (the sweep that would have caught #2) — skipped by `--fast`;
- `ldd` reports an unresolved library for any bundled lib, binary, or WebKit
  helper — skipped by `--fast`;
- the AppRun hook is missing any of the expected env exports;
- fewer than 200 GStreamer plugins are bundled, or any of
  `wavparse`/`autodetect`/`pulseaudio`/`mpg123` is absent;
- the bundled gdk-pixbuf stack cannot decode the app icon PNG
  (soft-skipped if `python-gobject` isn't installed).

## GStreamer version guard

Host plugins only register against a core of the same `major.minor`:

- A `--skip-build` re-repair after a host `gstreamer` upgrade **hard-fails by
  design** ("re-run without --skip-build") because the frozen bundled core
  would reject the freshly copied host plugins.
- The `gst-plugins-good` download is version-checked against the installed
  `gstreamer`; if the rolling repo has drifted ahead, the matching version is
  fetched from `archive.archlinux.org` instead (or the script tells you to
  `pacman -S gst-plugins-good`, after which no download is needed at all).

## Backend / env behavior of the repaired AppImage

- `GDK_BACKEND` defaults to `wayland,x11` — native Wayland first (the
  linuxdeploy default pins `x11` for [tauri#8541](https://github.com/tauri-apps/tauri/issues/8541),
  which doesn't reproduce with this bundle). `GDK_BACKEND=x11` at launch overrides.
- `GTK_PATH` is APPDIR-only (the stock hook mixes host module dirs in, which
  invites GTK version skew on rolling hosts).
- Updater: disabled (see defect #6). Re-enable for one launch with
  `READEST_DISABLE_UPDATER=0 ./Readest_*.AppImage` — note that any other
  value, including empty, still counts as "disabled" because the app checks
  only the variable's presence.

## Non-goals / accepted limitations

- **speech-dispatcher** isn't installed, so the WebSpeech ("System") TTS
  client is voiceless; the OpenAI-compatible and Edge TTS clients are
  unaffected.
- **gst-libav is not bundled**: `openh264` + `faad` + `mpg123` + `vpx` already
  cover mp3/aac/m4a/h264/webm (Edge TTS, EPUB media overlays, the ambient
  video); libav would add ~40 MB of ffmpeg for marginal formats.
- **WebKit's bwrap sandbox stays disabled** inside the AppImage — standard
  for AppImage WebKit bundles.
- The `qtpaths: command not found` stderr spam comes from the bundled
  `xdg-mime` probing KDE; xdg-utils falls back to its generic path and works.
  Cosmetic, left alone.

Notes:

- The build still exits non-zero with a `TAURI_SIGNING_PRIVATE_KEY` error
  after the bundle is written; that's the updater-artifact signing step and
  is harmless for local builds. The script tolerates it.
- The repaired AppImage borrows the remaining libraries from the machine it
  was built on — it's a personal build, not a redistributable one. Runtime
  host dependencies include the glycin loaders (image decode) and the
  PulseAudio/PipeWire socket.
- Tauri's single-instance plugin forwards a second launch to the running
  instance over the session D-Bus; test a second copy with
  `dbus-run-session -- ./Readest_*.AppImage`.
