# `Sideby Pass`

A Chrome extension that detects video URLs and instantly creates watch rooms on Sideby.me. Grab any video, invite friends, & watch together.

## What it does

TL;DR:

- Auto-detects videos on any page (mp4, m3u8/HLS)
- YouTube video support (watch pages & shorts)
- One-click room creation
- Context menu integration ("Play with Sideby Pass")
- Copy direct video links

## Installation

### Development / Unpacked

1. Clone this repo
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select the `pass.sideby,me` folder

### Chrome Web Store

_soon?_

## Usage

1. Navigate to any page with a video
2. Click the Sideby Pass icon in your toolbar
3. The extension will detect available videos
4. Select a video and click **Create Room** or **Grab Link**

You can also right-click on any video/link and select **Play with Sideby Pass**.

## Project Structure

```
├── manifest.json       # Extension config (MV3)
├── background.js       # Service worker - video detection via webRequest
├── contentScript.js    # DOM scanning & message forwarding
├── watcher.js          # XHR/fetch interception for video URLs
├── popup.html          # Extension popup UI
├── popup.css           # Popup styling
├── popup.js            # Popup logic & state management
└── icon-*.png          # Extension icons
```

## How It Works

The extension uses multiple detection strategies:

1. **webRequest API** - Monitors network requests for video content types
2. **DOM Scanning** - Finds `<video>` elements and their sources
3. **XHR/Fetch Hooks** - Intercepts video requests from JavaScript players
4. **YouTube Integration** - Direct support for YouTube watch pages

Detected videos are scored by quality indicators (file size, URL patterns) and the best match is shown first.

## Contributing

If you find ways to make improvements (or find one of million bugs), feel free to open an issue or a pull request!
