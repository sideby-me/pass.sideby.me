
// Sideby Pass - Content Script
// Listens for video-found events from watcher.js, scans DOM for videos, parses JSON script tags, checks og:video meta tags.

(function () {
  if (window.__sidebyContentInjected) return;
  window.__sidebyContentInjected = true;

  const SIDEBY_EVENT = 'sideby:video-found';
  const CLEAR_EVENT = 'sideby:clear-videos';
  const PROCESSED_CLASS = 'sideby-processed';

  // Utilities
  function searchKey(obj, key, results = []) {
    if (!obj || typeof obj !== 'object') return results;
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      if (k === key && obj[k]) {
        results.push(obj[k]);
      }
      if (typeof obj[k] === 'object') {
        searchKey(obj[k], key, results);
      }
    }
    return results;
  }

  function cleanByteRangeUrl(url) {
    return url
      .replace(/&bytestart=\d*/gi, '')
      .replace(/&byteend=\d*/gi, '')
      .replace(/\?bytestart=\d*&?/gi, '?')
      .replace(/\?$/g, '');
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0 
        && rect.left < window.innerWidth && rect.right > 0;
  }

  function sendVideo(video) {
    chrome.runtime.sendMessage({
      type: 'ADD_VIDEO',
      url: video.url,
      quality: video.quality,
      source: video.source,
      title: video.title || document.title,
      pageUrl: document.location.href,
      playlist: video.playlist,
    });
  }

  // Event listeners (from watcher.js)
  window.addEventListener(SIDEBY_EVENT, event => {
    const video = event.detail;
    if (!video || !video.url) return;
    sendVideo(video);
  });

  window.addEventListener(CLEAR_EVENT, () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_VIDEOS' });
  });

  // YouTube direct URL
  function checkYouTube() {
    if (!window.location.hostname.includes('youtube.com')) return;
    const url = window.location.href;
    
    if (url.includes('/watch') || url.includes('/shorts/')) {
      sendVideo({
        url: url,
        source: 'youtube',
        title: document.title.replace(' - YouTube', ''),
      });
    }
  }

  if (window.location.hostname.includes('youtube.com')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(checkYouTube, 1000));
    } else {
      setTimeout(checkYouTube, 1000);
    }
    
    let lastYouTubeUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastYouTubeUrl) {
        lastYouTubeUrl = window.location.href;
        chrome.runtime.sendMessage({ type: 'CLEAR_VIDEOS' });
        setTimeout(checkYouTube, 500);
      }
    }, 500);
  }

  // DOM video scanning
  function scanVideos() {
    const videos = document.querySelectorAll('video');
    
    for (const video of videos) {
      if (video.classList.contains(PROCESSED_CLASS)) continue;
      
      const urls = [];
      
      // Prefer playing and visible videos
      const isPlaying = !video.paused && !video.ended && video.currentTime > 0;
      const isVisible = isInViewport(video);
      
      // Get src
      if (video.src && !video.src.startsWith('blob:') && !video.src.startsWith('data:')) {
        urls.push(video.src);
      }
      if (video.currentSrc && !video.currentSrc.startsWith('blob:') && !video.currentSrc.startsWith('data:')) {
        urls.push(video.currentSrc);
      }
      
      // Get source elements
      for (const source of video.querySelectorAll('source[src]')) {
        if (source.src && !source.src.startsWith('blob:') && !source.src.startsWith('data:')) {
          urls.push(source.src);
        }
      }
      
      // Send unique URLs
      const seen = new Set();
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        
        // Clean byte-range URLs
        const cleanUrl = cleanByteRangeUrl(url);
        if (cleanUrl.includes('bytestart=') || cleanUrl.includes('byteend=')) continue;
        
        sendVideo({
          url: cleanUrl,
          source: isPlaying && isVisible ? 'dom-playing' : 'dom',
          title: document.title,
        });
      }
      
      video.classList.add(PROCESSED_CLASS);
    }
  }

  // OG:VIDEO meta tag scanning
  function scanMetaTags() {
    const ogVideo = document.querySelector('meta[property="og:video"]');
    if (ogVideo && ogVideo.content) {
      sendVideo({
        url: ogVideo.content,
        source: 'og:video',
        title: document.title,
      });
    }
    
    const ogVideoUrl = document.querySelector('meta[property="og:video:url"]');
    if (ogVideoUrl && ogVideoUrl.content) {
      sendVideo({
        url: ogVideoUrl.content,
        source: 'og:video',
        title: document.title,
      });
    }
    
    const ogVideoSecure = document.querySelector('meta[property="og:video:secure_url"]');
    if (ogVideoSecure && ogVideoSecure.content) {
      sendVideo({
        url: ogVideoSecure.content,
        source: 'og:video',
        title: document.title,
      });
    }
  }

  // JSON script tag scanning (Instagram stories, etc.)
  function scanJsonScripts() {
    const hostname = window.location.hostname;
    
    // Instagram: look for video_versions in JSON scripts
    if (hostname.includes('instagram.com')) {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const script of scripts) {
        if (script.classList.contains(PROCESSED_CLASS)) continue;
        
        const text = script.innerText || script.textContent;
        if (!text || !text.includes('video_versions')) continue;
        
        try {
          const data = JSON.parse(text);
          const versions = searchKey(data, 'video_versions');
          
          for (const vArr of versions) {
            if (!Array.isArray(vArr) || !vArr.length) continue;
            
            const sorted = [...vArr].sort((a, b) => (b.width || 0) - (a.width || 0));
            const best = sorted[0];
            
            if (best && best.url) {
              sendVideo({
                url: cleanByteRangeUrl(best.url),
                quality: best.width ? `${best.width}p` : null,
                source: 'instagram-json',
                title: document.title,
              });
            }
          }
          
          script.classList.add(PROCESSED_CLASS);
        } catch (e) {}
      }
    }
    
    // TikTok: parse __UNIVERSAL_DATA_FOR_REHYDRATION__
    if (hostname.includes('tiktok.com')) {
      const rehydration = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (rehydration && !rehydration.classList.contains(PROCESSED_CLASS)) {
        try {
          const data = JSON.parse(rehydration.textContent);
          const itemStruct = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
          
          if (itemStruct) {
            const bitrateInfo = itemStruct.video?.bitrateInfo?.[0];
            const playAddr = bitrateInfo?.PlayAddr;
            
            if (playAddr && playAddr.UrlList && playAddr.UrlList.length) {
              // Filter out webapp-prime URLs
              const urls = playAddr.UrlList.filter(u => !u.includes('v16-webapp-prime'));
              if (urls[0]) {
                sendVideo({
                  url: urls[0],
                  quality: playAddr.Width ? `${playAddr.Width}p` : null,
                  source: 'tiktok',
                  title: itemStruct.desc || document.title,
                });
              }
            }
          }
          
          rehydration.classList.add(PROCESSED_CLASS);
        } catch (e) {}
      }
    }
  }

  // Message handlers
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GET_PAGE_INFO') {
      sendResponse({
        title: document.title || '',
        pageUrl: window.location.href,
      });
      return true;
    }

    if (message?.type === 'SCAN_DOM') {
      scanVideos();
      scanMetaTags();
      scanJsonScripts();
      sendResponse({ success: true });
      return true;
    }
  });

  // Initialization
  function runScans() {
    scanVideos();
    scanMetaTags();
    scanJsonScripts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(runScans, 500));
  } else {
    setTimeout(runScans, 500);
  }

  // Re-scan when DOM changes
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        const hasMedia = [...mutation.addedNodes].some(
          node => node.nodeName === 'VIDEO' || 
                  node.nodeName === 'SCRIPT' ||
                  node.querySelector?.('video')
        );
        if (hasMedia) {
          runScans();
          break;
        }
      }
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
