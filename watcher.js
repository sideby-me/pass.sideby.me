// Sideby Pass - XHR Watcher
// Injected into page context (MAIN world) at document_start
// Intercepts XHR/Fetch and parses responses based on current site

(function () {
  if (window.__sidebyWatcherInjected) return;
  window.__sidebyWatcherInjected = true;

  const SIDEBY_EVENT = "sideby:video-found";
  const CLEAR_EVENT = "sideby:clear-videos";

  let lastUrl = document.location.href;
  const foundVideos = new Set();

  // Utilities
  function dispatchVideo(video) {
    if (!video.url || foundVideos.has(video.url)) return;

    // Flag already-proxied URLs (lower confidence)
    if (isAlreadyProxied(video.url)) {
      video.alreadyProxied = true;
    }

    // Embed page origin headers for proxy to use (unless already has headers)
    if (!video.url.includes("headers=") && !video.alreadyProxied) {
      const pageReferer = document.location.href;
      const pageOrigin = document.location.origin;
      video.url = embedHeaders(video.url, pageReferer, pageOrigin);
    }

    foundVideos.add(video.url);

    try {
      window.dispatchEvent(new CustomEvent(SIDEBY_EVENT, { detail: video }));
    } catch (e) {}
  }

  function checkUrlChange() {
    if (document.location.href !== lastUrl) {
      lastUrl = document.location.href;
      foundVideos.clear();
      window.dispatchEvent(new CustomEvent(CLEAR_EVENT));
    }
  }
  setInterval(checkUrlChange, 500);

  function searchKey(obj, key, results = [], extractTitle = false) {
    if (!obj || typeof obj !== "object") return results;
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (k === key && obj[k]) {
        // If extractTitle is true, look for sibling caption.text (Instagram)
        if (extractTitle && obj.caption?.text && Array.isArray(obj[k])) {
          for (const item of obj[k]) {
            if (item && typeof item === "object") {
              item._title = obj.caption.text;
            }
          }
        }
        results.push(obj[k]);
      }
      if (typeof obj[k] === "object") {
        searchKey(obj[k], key, results, extractTitle);
      }
    }
    return results;
  }

  // Clean byte-range params from Instagram URLs
  function cleanByteRangeUrl(url) {
    return url
      .replace(/&bytestart=\d*/gi, "")
      .replace(/&byteend=\d*/gi, "")
      .replace(/\?bytestart=\d*&?/gi, "?")
      .replace(/\?$/g, "");
  }

  // Check if a string is a valid URL
  function isValidUrl(str) {
    try {
      const url = new URL(str);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  // Embed referer/origin headers into a video URL for proxy to use
  function embedHeaders(videoUrl, referer, origin) {
    if (!referer && !origin) return videoUrl;
    // Skip if headers already embedded
    if (videoUrl.includes("headers=")) return videoUrl;

    try {
      const headers = {};
      // Only embed valid URLs as referer/origin
      if (referer && isValidUrl(referer)) headers.referer = referer;
      if (origin && isValidUrl(origin)) headers.origin = origin;

      if (Object.keys(headers).length === 0) return videoUrl;

      const url = new URL(videoUrl);
      url.searchParams.set("headers", JSON.stringify(headers));
      return url.toString();
    } catch {
      return videoUrl;
    }
  }

  // Detect already-proxied URLs to avoid double-proxying
  function isAlreadyProxied(url) {
    const proxyPatterns = [
      /m3u8-proxy\?url=/i,
      /pipe\.sideby\.me/i,
      /\/proxy\/\?url=/i,
    ];
    return proxyPatterns.some((p) => p.test(url));
  }

  // Site-specific parsers
  const InstagramParser = {
    origins: ["www.instagram.com", "instagram.com", /instagram\.com/],

    onLoad(responseText, url) {
      if (!responseText.includes("video_versions")) return;

      try {
        // Instagram sometimes prefixes with "for (;;);"
        const cleaned = responseText.replace(/^for\s*\(;;\);?/g, "");
        const data = JSON.parse(cleaned);
        // Extract title from caption.text if present
        const videoVersions = searchKey(data, "video_versions", [], true);

        for (const versions of videoVersions) {
          if (!Array.isArray(versions) || !versions.length) continue;

          // Sort by width (highest first)
          const sorted = [...versions].sort(
            (a, b) => (b.width || 0) - (a.width || 0)
          );

          for (const v of sorted) {
            if (v && v.url) {
              const cleanUrl = cleanByteRangeUrl(v.url);
              // Use caption title if extracted, otherwise document.title
              const title = v._title || document.title;
              dispatchVideo({
                url: cleanUrl,
                quality: v.width ? `${v.width}p` : null,
                source: "instagram",
                title: title,
              });
              break; // Only take best quality
            }
          }
        }
      } catch (e) {}
    },
  };

  const TwitterParser = {
    origins: [/twitter\.com/, /x\.com/],

    onLoad(responseText, url) {
      if (!responseText.includes("video_info")) return;

      try {
        const data = JSON.parse(responseText);
        const videoInfos = searchKey(data, "video_info");

        for (const info of videoInfos) {
          if (!info || !info.variants || !Array.isArray(info.variants))
            continue;

          // Filter out HLS, keep MP4s
          const mp4Variants = info.variants.filter(
            (v) =>
              v.url &&
              v.content_type !== "application/x-mpegURL" &&
              !v.url.includes(".m3u8")
          );

          if (!mp4Variants.length) continue;

          // Sort by bitrate (highest first)
          mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          const best = mp4Variants[0];

          // Extract quality from URL (e.g., /avc1/720x1280/)
          let quality = null;
          const match = best.url.match(/avc1\/(\d+)x(\d+)/);
          if (match) {
            quality = `${Math.min(parseInt(match[1]), parseInt(match[2]))}p`;
          }

          dispatchVideo({
            url: best.url,
            quality: quality,
            source: "twitter",
            title: document.title,
          });
        }
      } catch (e) {}
    },
  };

  const VimeoParser = {
    origins: [/vimeo\.com/],

    onLoad(responseText, url) {
      if (!url.includes("/config")) return;

      try {
        const data = JSON.parse(responseText);
        const title =
          document.querySelector("#main main h1")?.innerText || document.title;

        // Check progressive files first
        const progressive = data?.request?.files?.progressive;
        if (progressive && progressive.length) {
          // Sort by width (highest first)
          const sorted = [...progressive].sort(
            (a, b) => (b.width || 0) - (a.width || 0)
          );
          for (const p of sorted) {
            dispatchVideo({
              url: p.url,
              quality: p.width ? `${p.width}p` : null,
              source: "vimeo",
              title: title,
            });
          }
          return;
        }

        // Fall back to HLS
        const hls = data?.request?.files?.hls;
        if (hls && hls.cdns) {
          for (const cdnKey in hls.cdns) {
            const cdnUrl = hls.cdns[cdnKey].url;
            if (cdnUrl && !cdnUrl.includes("cme-media.vimeocdn.com")) {
              dispatchVideo({
                url: cdnUrl.replace(/\/subtitles\/.*\//, "/"),
                quality: data?.video?.height ? `${data.video.height}p` : null,
                source: "vimeo",
                title: title,
                playlist: true,
              });
            }
          }
        }
      } catch (e) {}
    },
  };

  const HLSParser = {
    origins: [], // Matches all sites

    onLoad(responseText, url) {
      if (!responseText.includes("#EXTM3U")) return;
      if (!url.includes(".m3u8")) return;

      try {
        const title = document.title;
        const variants = [];

        // Parse master playlist
        if (responseText.includes("#EXT-X-STREAM-INF:")) {
          const segments = responseText.split("#EXT-X-STREAM-INF:");

          for (const segment of segments) {
            if (!segment.trim()) continue;

            let quality = null;
            let variantUrl = null;

            const parts = segment.split(/[\s,\n]+/);
            for (const part of parts) {
              if (part.includes("RESOLUTION=")) {
                const res = part.split("=")[1];
                if (res) {
                  quality = res.split("x")[1] + "p";
                }
              }
              // Skip comment lines when looking for URLs
              if (
                !part.startsWith("#") &&
                (part.includes(".m3u8") || part.match(/^https?:\/\//))
              ) {
                variantUrl = part.trim();
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

          // Sort by quality and dispatch best
          variants.sort((a, b) => {
            const qa = parseInt(a.quality) || 0;
            const qb = parseInt(b.quality) || 0;
            return qb - qa;
          });

          for (const v of variants) {
            dispatchVideo({
              url: v.url,
              quality: v.quality,
              source: "hls",
              title: title,
              playlist: true,
            });
          }
        } else {
          // Single variant playlist - dispatch the master URL
          dispatchVideo({
            url: url,
            source: "hls",
            title: title,
            playlist: true,
          });
        }
      } catch (e) {}
    },
  };

  const GenericParser = {
    origins: [], // Matches all sites

    onLoad(responseText, url) {
      try {
        const data = JSON.parse(responseText);
        const videoKeys = [
          "file",
          "video_url",
          "video",
          "source",
          "src",
          "stream_url",
          "download_url",
          "url",
        ];

        for (const key of videoKeys) {
          const values = searchKey(data, key);
          for (const value of values) {
            if (
              typeof value === "string" &&
              value.match(/\.(mp4|m3u8)(\?|$)/i)
            ) {
              // Skip segments and byte-range URLs
              if (value.includes("bytestart=") || value.includes("byteend="))
                continue;
              if (value.match(/seg-\d+|chunk-\d+|fragment-\d+/i)) continue;

              dispatchVideo({
                url: value,
                source: "api",
                title: document.title,
              });
            }
          }
        }
      } catch (e) {}
    },
  };

  // Order matters - site-specific first, then generic
  const parsers = [
    InstagramParser,
    TwitterParser,
    VimeoParser,
    HLSParser,
    GenericParser,
  ];

  // XHR interception
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._sidebyUrl = url;
    this._sidebyMethod = method;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        let fullUrl = this._sidebyUrl;
        if (fullUrl && !fullUrl.startsWith("http")) {
          fullUrl = document.location.origin + fullUrl;
        }

        let responseText = "";
        try {
          responseText = this.responseText;
        } catch (e) {
          return;
        }

        if (!responseText || responseText.length < 10) return;

        const hostname = document.location.hostname;

        for (const parser of parsers) {
          // Check if parser applies to this site (supports both strings and regex)
          if (
            parser.origins.length === 0 ||
            parser.origins.some((o) => {
              if (o instanceof RegExp) return o.test(hostname);
              return hostname === o || hostname.includes(o);
            })
          ) {
            parser.onLoad(responseText, fullUrl);
          }
        }
      } catch (e) {}
    });

    return originalSend.apply(this, arguments);
  };

  // Fetch interception
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const clone = response.clone();
      const url =
        response.url || (typeof args[0] === "string" ? args[0] : args[0]?.url);

      const contentType = response.headers.get("content-type") || "";
      if (
        contentType.includes("json") ||
        contentType.includes("text") ||
        contentType.includes("mpegurl")
      ) {
        clone
          .text()
          .then((text) => {
            if (!text || text.length < 10) return;

            const hostname = document.location.hostname;

            for (const parser of parsers) {
              // Check if parser applies to this site (supports both strings and regex)
              if (
                parser.origins.length === 0 ||
                parser.origins.some((o) => {
                  if (o instanceof RegExp) return o.test(hostname);
                  return hostname === o || hostname.includes(o);
                })
              ) {
                parser.onLoad(text, url);
              }
            }
          })
          .catch(() => {});
      }
    } catch (e) {}

    return response;
  };

  console.log("Sideby Pass: Watcher initialized");
})();
