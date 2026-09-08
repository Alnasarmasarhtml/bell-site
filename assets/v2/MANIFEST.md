# BELL v2 web assets

Directory: `site/assets/v2/`  
Sources: `art/v2/*` (floors, props, cutout, banner, logo), `art/bell-hero.png` (hero bell). Medals, stamp and audio are generated in code.

## Floors (webp q82)

| File | Size | Details | Notes |
|---|---:|---|---|
| `drop-floor-1024.webp` | 135.9 KB | 1024x576 RGB |  |
| `drop-floor-1600.webp` | 255.9 KB | 1600x900 RGB |  |
| `hero-floor-1024.webp` | 127.6 KB | 1024x576 RGB |  |
| `hero-floor-1600.webp` | 230.8 KB | 1600x900 RGB |  |
| `hero-floor-2304.webp` | 361.7 KB | 2304x1296 RGB |  |
| `hero-floor-placeholder.jpg` | 0.6 KB | 24x14 RGB | blur-up placeholder (24 px wide, gaussian blur) |
| `night-floor-1024.webp` | 47.9 KB | 1024x576 RGB |  |
| `night-floor-1600.webp` | 89.3 KB | 1600x900 RGB |  |
| `race-floor-1024.webp` | 75.8 KB | 1024x576 RGB |  |
| `race-floor-1600.webp` | 139.7 KB | 1600x900 RGB |  |

## Ringer cutout

| File | Size | Details | Notes |
|---|---:|---|---|
| `cut-ringer-450.png` | 133.9 KB | 376x450 RGBA | trimmed to alpha bbox + 2% pad before scaling |
| `cut-ringer-900.png` | 430.2 KB | 752x900 RGBA | trimmed to alpha bbox + 2% pad before scaling |
| `cut-ringer-point-450.png` | 125.1 KB | 362x450 RGBA | pointing pose (GPT Image 2 from the idle render), key2.py flood key, trimmed + 2% pad; webp beside it |
| `cut-ringer-point-900.png` | 407.1 KB | 723x900 RGBA | same, 2x |

## Props

| File | Size | Details | Notes |
|---|---:|---|---|
| `prop-arrow-128.png` | 13.9 KB | 128x128 RGBA |  |
| `prop-arrow-256.png` | 45.2 KB | 256x256 RGBA |  |
| `prop-bell-128.png` | 16.1 KB | 128x128 RGBA |  |
| `prop-bell-256.png` | 51.5 KB | 256x256 RGBA |  |
| `prop-chart-128.png` | 20.8 KB | 128x128 RGBA |  |
| `prop-chart-256.png` | 67.0 KB | 256x256 RGBA |  |
| `prop-chipcoin-128.png` | 25.9 KB | 128x128 RGBA |  |
| `prop-chipcoin-256.png` | 83.5 KB | 256x256 RGBA |  |
| `prop-coins-128.png` | 24.0 KB | 128x128 RGBA |  |
| `prop-coins-256.png` | 78.7 KB | 256x256 RGBA |  |
| `prop-gavel-128.png` | 19.7 KB | 128x128 RGBA |  |
| `prop-gavel-256.png` | 63.6 KB | 256x256 RGBA |  |
| `prop-moneybag-128.png` | 27.2 KB | 128x128 RGBA |  |
| `prop-moneybag-256.png` | 87.1 KB | 256x256 RGBA |  |
| `prop-stopwatch-128.png` | 20.6 KB | 128x128 RGBA |  |
| `prop-stopwatch-256.png` | 65.0 KB | 256x256 RGBA |  |
| `prop-tape-128.png` | 25.7 KB | 128x128 RGBA |  |
| `prop-tape-256.png` | 84.5 KB | 256x256 RGBA |  |

## Hero bell

| File | Size | Details | Notes |
|---|---:|---|---|
| `bell-hero-800.png` | 238.8 KB | 625x800 RGBA | longest side 800 (source 982x1256) |

## Banner

| File | Size | Details | Notes |
|---|---:|---|---|
| `banner-1500x500.jpg` | 259.5 KB | 1500x500 RGB |  |
| `banner-1500x500.png` | 1.06 MB | 1500x500 RGB |  |

## Logo + favicon

| File | Size | Details | Notes |
|---|---:|---|---|
| `favicon.ico` | 1.9 KB | ICO 16x16 + 32x32, RGBA | from keyed logo |
| `logo-1024.png` | 327.2 KB | 1024x1024 RGBA | white background flood-keyed to alpha (incl. crown hole), soft 2 px edge |
| `logo-192.png` | 21.9 KB | 192x192 RGBA |  |
| `logo-32.png` | 1.3 KB | 32x32 RGBA |  |
| `logo-512.png` | 114.6 KB | 512x512 RGBA |  |
| `logo-64.png` | 3.7 KB | 64x64 RGBA |  |

## Pixel medal set + stamp

| File | Size | Details | Notes |
|---|---:|---|---|
| `medal-blue-128.png` | 2.7 KB | 128x128 RGBA | lighter blue face + white outline so the blue bell separates |
| `medal-gold-128.png` | 2.7 KB | 128x128 RGBA | voxel disc + striped ribbon + ring, prop-bell composited with 1 px outline |
| `medal-silver-128.png` | 2.7 KB | 128x128 RGBA | same build, silver palette |
| `ringer-stamp.png` | 1.3 KB | 344x120 RGBA | hand-set 5x7 pixel font, double frame, worn-ink speckle, brand blue |

## Audio

| File | Size | Details | Notes |
|---|---:|---|---|
| `bell.mp3` | 14.2 KB | MP3 (libmp3lame VBR q2) | ffmpeg encode of bell.wav |
| `bell.wav` | 215.4 KB | 2.50 s, 44100 Hz, 16-bit, 1 ch | exchange bell: 880 (+881.6 shimmer) / 1320 / 2640 Hz partials, 1.5 ms attack, 1.6 s exp decay (-60 dB), 2nd strike at 0.6 s, peak -3 dBFS |
| `tick.mp3` | 1.2 KB | MP3 (libmp3lame VBR q2) | ffmpeg encode of tick.wav |
| `tick.wav` | 3.9 KB | 0.04 s, 44100 Hz, 16-bit, 1 ch | soft UI tick: 1.2 kHz blip + dulled click, 45 ms, peak -14 dBFS |

**47 files, 5.03 MB total.**

## 4K refresh (2026-09-09)
Every floor, cutout, prop, sprite, logo and banner above was regenerated from the 4K sources in art/v3 (GPT Image 2 image2image at the 4k tier, 3584x2016 for 16:9 and 2048 square) with the same filenames, plus new tiers: `*-floor-3584.webp`, `*-floor-2560.webp`, `cut-ringer-1800`, `cut-ringer-idle-1800`, `cut-bull-1440`, `prop-*-512`. Frame sets in assets/frames now come from the Seedance 2.0 4K clips: `hero-4k` and `night-4k` (3840x2160) plus xl (1920), base (1280) and sm (640) downscaled from the 4K masters.
