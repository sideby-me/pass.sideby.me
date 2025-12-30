const APP_BASE_URL = "https://sideby.me";

// Sideby Pass - Background Script
// Handles video detection via webRequest API, message handling from content scripts & M3U8 playlist fetching/parsing

// Store detected video URLs per tab
const videosByTab = new Map();

// Config
const MIN_VIDEO_SIZE_BYTES = 500_000;
const MAX_RESULTS = 5;
const ENTRY_TTL_MS = 10 * 60 * 1000;

// HLS Content Types
const HLS_CONTENT_TYPES = [
  "audio/mpegurl",
  "application/mpegurl",
  "application/x-mpegurl",
  "audio/x-mpegurl",
  "application/vnd.apple.mpegurl",
  "application/vnd.apple.mpegurl.audio",
];

// Patterns for video detection
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|m3u8)(\?|#|$)/i;
const SEGMENT_EXTENSIONS = /\.(ts|m4s|m4a)(\?|#|$)/i;
const VIDEO_CONTENT_TYPES =
  /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl))/i;

// Patterns to identify segments (should be filtered out)
const SEGMENT_PATTERNS = [
  /[_\-/](seg|segment|frag|fragment|chunk|part)[_\-]?\d+/i,
  /[_\-/]init[_\-]?\d*\.(mp4|m4s)/i,
  /[&?]range=\d+[_\-]\d+/i,
  /\/range\/\d+/i,
  /[&?]bytestart=/i,
  /[&?]byteend=/i,
];

// Patterns to identify audio-only
const AUDIO_ONLY_PATTERNS = [
  /[_\-/]audio[_\-/]/i,
  /audio[_\-]only/i,
  /\.m4a(\?|#|$)/i,
  /\.aac(\?|#|$)/i,
];

// Source priority scores (higher = more relevant)
const SOURCE_PRIORITY = {
  instagram: 100,
  twitter: 100,
  vimeo: 100,
  tiktok: 100,
  "instagram-json": 95,
  api: 90,
  hls: 85,
  "og:video": 80,
  "dom-playing": 75,
  dom: 50,
  webRequest: 40,
};

// URL utilities
function cleanByteRangeUrl(url) {
  return url
    .replace(/&bytestart=\d*/gi, "")
    .replace(/&byteend=\d*/gi, "")
    .replace(/\?bytestart=\d*&?/gi, "?")
    .replace(/\?$/g, "");
}

// Video filtering
function isPlayableVideo(url, contentType, size, source) {
  const lower = url.toLowerCase();

  // Always allow site-specific sources
  if (source && SOURCE_PRIORITY[source] >= 75) {
    return true;
  }

  // Allow YouTube URLs (played directly)
  if (
    lower.includes("youtube.com/watch") ||
    lower.includes("youtube.com/shorts/") ||
    lower.includes("youtu.be/")
  ) {
    return true;
  }

  // Filter out webm
  if (/\.webm(\?|#|$)/i.test(lower)) return false;

  // Filter out m4s segments
  if (/\.m4s(\?|#|$)/i.test(lower)) return false;

  // Must have video extension or content type
  const hasVideoExt = VIDEO_EXTENSIONS.test(lower);
  const hasSegmentExt = SEGMENT_EXTENSIONS.test(lower);
  const hasVideoContentType =
    contentType && VIDEO_CONTENT_TYPES.test(contentType);

  if (!hasVideoExt && !hasVideoContentType) {
    if (hasSegmentExt && size && size > MIN_VIDEO_SIZE_BYTES * 2) {
      // Large segment might be complete video
    } else {
      return false;
    }
  }

  // Filter segment patterns
  for (const pattern of SEGMENT_PATTERNS) {
    if (pattern.test(lower)) return false;
  }

  // Filter audio-only
  for (const pattern of AUDIO_ONLY_PATTERNS) {
    if (pattern.test(lower)) return false;
  }

  // Filter by size if available
  if (size && size < MIN_VIDEO_SIZE_BYTES) return false;

  return true;
}

// Video scoring
function scoreVideo(url, size, source, quality) {
  let score = 10;
  const lower = url.toLowerCase();

  // Source priority (biggest factor)
  if (source && SOURCE_PRIORITY[source]) {
    score += SOURCE_PRIORITY[source];
  }

  // Extension boost
  if (/\.mp4(\?|#|$)/i.test(lower)) score += 20;
  else if (/\.m3u8(\?|#|$)/i.test(lower)) score += 15;

  // Size boost
  if (size) {
    if (size > 50_000_000) score += 30;
    else if (size > 10_000_000) score += 20;
    else if (size > 5_000_000) score += 10;
  }

  // Quality boost
  if (quality) {
    const q = parseInt(quality);
    if (q >= 1080) score += 15;
    else if (q >= 720) score += 10;
    else if (q >= 480) score += 5;
  }

  // Boost known quality indicators in URL
  if (/1080|1920|hd|high/i.test(lower)) score += 5;
  if (/720/i.test(lower)) score += 3;

  return score;
}

// Video retrieval
function getVideosForTab(tabId) {
  const tabVideos = videosByTab.get(tabId);
  if (!tabVideos) return [];

  const now = Date.now();
  const results = [];

  for (const [url, info] of tabVideos.entries()) {
    // Skip expired
    if (now - info.timestamp > ENTRY_TTL_MS) {
      tabVideos.delete(url);
      continue;
    }

    // Skip non-playable
    if (!isPlayableVideo(url, info.contentType, info.size, info.source)) {
      continue;
    }

    results.push({
      url,
      size: info.size,
      score: scoreVideo(url, info.size, info.source, info.quality),
      timestamp: info.timestamp,
      quality: info.quality,
      source: info.source,
      title: info.title,
      playlist: info.playlist,
    });
  }

  // Sort by score (desc), then timestamp (desc)
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.timestamp - a.timestamp;
  });

  return results.slice(0, MAX_RESULTS);
}

// M3U8 parsing
async function fetchAndParseM3U8(url, tabId) {
  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!text.includes("#EXTM3U")) return;

    const variants = [];

    if (text.includes("#EXT-X-STREAM-INF:")) {
      // Master playlist - parse variants
      const segments = text.split("#EXT-X-STREAM-INF:");

      for (const segment of segments) {
        if (!segment.trim()) continue;

        let quality = null;
        let variantUrl = null;

        const lines = segment.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.includes("RESOLUTION=")) {
            const match = trimmed.match(/RESOLUTION=(\d+)x(\d+)/);
            if (match) {
              quality = `${Math.min(parseInt(match[1]), parseInt(match[2]))}p`;
            }
          }

          if (
            trimmed &&
            !trimmed.startsWith("#") &&
            (trimmed.includes(".m3u8") || trimmed.match(/^https?:\/\//))
          ) {
            variantUrl = trimmed;
          }
        }

        if (variantUrl) {
          // Make absolute URL if relative
          if (!variantUrl.startsWith("http")) {
            const baseMatch = url.match(/(.+\/)[^\/]+\.m3u8/i);
            if (baseMatch) {
              variantUrl = baseMatch[1] + variantUrl;
            }
          }
          variants.push({ url: variantUrl, quality });
        }
      }

      // Sort by quality and add best variants
      variants.sort((a, b) => {
        const qa = parseInt(a.quality) || 0;
        const qb = parseInt(b.quality) || 0;
        return qb - qa;
      });

      for (const v of variants.slice(0, 3)) {
        addVideoToTab(tabId, {
          url: v.url,
          quality: v.quality,
          source: "hls",
          title: null,
          playlist: true,
        });
      }
    }
  } catch (e) {}
}

// Video storage
function addVideoToTab(tabId, video) {
  if (!tabId || !video.url) return;
  if (video.url.startsWith("blob:") || video.url.startsWith("data:")) return;

  // Clean the URL
  const cleanUrl = cleanByteRangeUrl(video.url);

  if (!videosByTab.has(tabId)) {
    videosByTab.set(tabId, new Map());
  }

  const tabVideos = videosByTab.get(tabId);
  const existing = tabVideos.get(cleanUrl);

  if (!existing) {
    tabVideos.set(cleanUrl, {
      size: video.size || null,
      contentType: video.contentType || null,
      timestamp: Date.now(),
      source: video.source,
      quality: video.quality,
      title: video.title,
      playlist: video.playlist,
    });
  } else {
    // Update with higher priority source
    const existingPriority = SOURCE_PRIORITY[existing.source] || 0;
    const newPriority = SOURCE_PRIORITY[video.source] || 0;

    if (newPriority > existingPriority) {
      existing.source = video.source;
    }
    if (video.quality && !existing.quality) {
      existing.quality = video.quality;
    }
    if (video.title && !existing.title) {
      existing.title = video.title;
    }
  }
}

// WebRequest listener
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    try {
      if (!details.tabId || details.tabId < 0) return;

      const url = details.url;
      if (!url || url.startsWith("data:") || url.startsWith("blob:")) return;

      const contentTypeHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-type"
      );
      const contentType = contentTypeHeader?.value || "";

      // Check for M3U8/HLS content type
      const isHLS = HLS_CONTENT_TYPES.some((ct) =>
        contentType.toLowerCase().includes(ct)
      );
      const isM3U8Url = url.includes(".m3u8");

      if (isHLS || isM3U8Url) {
        // Fetch and parse M3U8 for variants
        fetchAndParseM3U8(url, details.tabId);

        // Also add the master playlist
        addVideoToTab(details.tabId, {
          url: url,
          contentType: contentType,
          source: "hls",
          playlist: true,
        });
        return;
      }

      // Check for regular video
      const hasVideoExt =
        VIDEO_EXTENSIONS.test(url) || SEGMENT_EXTENSIONS.test(url);
      const hasVideoContentType = VIDEO_CONTENT_TYPES.test(contentType);

      if (!hasVideoExt && !hasVideoContentType) return;

      const contentLengthHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-length"
      );
      const size = contentLengthHeader?.value
        ? parseInt(contentLengthHeader.value, 10)
        : null;

      addVideoToTab(details.tabId, {
        url: url,
        size: size,
        contentType: contentType,
        source: "webRequest",
      });
    } catch (e) {}
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// Tab cleanup
chrome.tabs.onRemoved.addListener((tabId) => {
  videosByTab.delete(tabId);
});

// Message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_VIDEOS") {
    const tabId = message.tabId;
    const videos = getVideosForTab(tabId);
    sendResponse({ videos });
    return true;
  }

  if (message?.type === "ADD_VIDEO") {
    const tabId = message.tabId || sender?.tab?.id;
    addVideoToTab(tabId, {
      url: message.url,
      source: message.source,
      quality: message.quality,
      title: message.title,
      playlist: message.playlist,
    });
    return true;
  }

  if (message?.type === "CLEAR_VIDEOS") {
    const tabId = sender?.tab?.id;
    if (tabId && videosByTab.has(tabId)) {
      videosByTab.get(tabId).clear();
    }
    return true;
  }
});

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: "sideby-pass",
      title: "Play with Sideby Pass",
      contexts: ["video", "link"],
    });
  } catch (e) {
    console.error("Failed to create context menu", e);
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "sideby-pass") return;

  const videoUrl = info.srcUrl || info.linkUrl;
  if (!videoUrl) return;

  const params = new URLSearchParams();
  params.set("videoUrl", videoUrl);
  params.set("autoplay", "1");

  const url = `${APP_BASE_URL}/create?${params.toString()}`;
  chrome.tabs.create({ url });
});
