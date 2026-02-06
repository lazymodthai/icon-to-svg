// Guard against re-injection
if (!window.__icon2svg_injected) {
  window.__icon2svg_injected = true
  initPicker()
}

function initPicker() {
  let active = false
  let overlay = null
  let highlight = null
  let toast = null

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_PICK') {
      startPick()
    }
  })

  function startPick() {
    if (active) return
    active = true

    // Overlay — covers page to intercept clicks
    overlay = document.createElement('div')
    overlay.id = '__icon2svg_overlay'
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      cursor: 'crosshair',
      background: 'rgba(0,0,0,0.05)',
    })

    // Highlight box
    highlight = document.createElement('div')
    highlight.id = '__icon2svg_highlight'
    Object.assign(highlight.style, {
      position: 'fixed',
      pointerEvents: 'none',
      border: '3px solid #6ab0f3',
      borderRadius: '4px',
      background: 'rgba(106,176,243,0.15)',
      zIndex: '2147483647',
      display: 'none',
      transition: 'top .05s, left .05s, width .05s, height .05s',
    })

    // Toast instruction
    toast = document.createElement('div')
    toast.id = '__icon2svg_toast'
    toast.textContent = 'Click an image to convert to SVG  \u2022  Press Esc to cancel'
    Object.assign(toast.style, {
      position: 'fixed',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      background: '#1b1b30',
      color: '#e0e0e0',
      padding: '10px 20px',
      borderRadius: '8px',
      fontSize: '14px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      pointerEvents: 'none',
    })

    document.documentElement.appendChild(overlay)
    document.documentElement.appendChild(highlight)
    document.documentElement.appendChild(toast)

    overlay.addEventListener('mousemove', onMouseMove)
    overlay.addEventListener('click', onClick)
    document.addEventListener('keydown', onKeyDown)
  }

  function cleanup() {
    active = false
    overlay?.remove()
    highlight?.remove()
    toast?.remove()
    overlay = null
    highlight = null
    toast = null
    document.removeEventListener('keydown', onKeyDown)
    window.__icon2svg_injected = false
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cleanup()
    }
  }

  function getImageElementAt(x, y) {
    // Temporarily hide overlay to hit-test through it
    overlay.style.pointerEvents = 'none'
    const el = document.elementFromPoint(x, y)
    overlay.style.pointerEvents = ''

    if (!el) return null

    // Direct <img>
    if (el.tagName === 'IMG' && el.src) return el

    // <canvas>
    if (el.tagName === 'CANVAS') return el

    // Element with background-image
    const bg = getComputedStyle(el).backgroundImage
    if (bg && bg !== 'none' && bg.startsWith('url(')) return el

    // Check if an <img> is a child (e.g., inside a wrapper div)
    const childImg = el.querySelector('img[src]')
    if (childImg) return childImg

    return null
  }

  function onMouseMove(e) {
    const imgEl = getImageElementAt(e.clientX, e.clientY)
    if (imgEl) {
      const r = imgEl.getBoundingClientRect()
      Object.assign(highlight.style, {
        display: 'block',
        top: r.top + 'px',
        left: r.left + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
      })
    } else {
      highlight.style.display = 'none'
    }
  }

  function onClick(e) {
    e.preventDefault()
    e.stopPropagation()

    const imgEl = getImageElementAt(e.clientX, e.clientY)
    if (!imgEl) return

    captureElement(imgEl)
    cleanup()
  }

  function captureElement(el) {
    if (el.tagName === 'CANVAS') {
      try {
        const dataUrl = el.toDataURL('image/png')
        sendCaptured(dataUrl)
        return
      } catch {
        // tainted canvas — fall through
      }
    }

    let srcUrl = null

    if (el.tagName === 'IMG') {
      srcUrl = el.src
    } else {
      // background-image
      const bg = getComputedStyle(el).backgroundImage
      const match = bg.match(/url\(["']?(.*?)["']?\)/)
      if (match) srcUrl = match[1]
    }

    if (!srcUrl) return

    // Try drawing to canvas (works for same-origin / CORS-enabled)
    if (el.tagName === 'IMG') {
      try {
        const c = document.createElement('canvas')
        c.width = el.naturalWidth || el.width
        c.height = el.naturalHeight || el.height
        const ctx = c.getContext('2d')
        ctx.drawImage(el, 0, 0)
        // This will throw if the canvas is tainted
        const dataUrl = c.toDataURL('image/png')
        sendCaptured(dataUrl)
        return
      } catch {
        // tainted canvas — fall through to URL-based fetch
      }
    }

    // CORS fallback: send URL to background for fetching
    chrome.runtime.sendMessage({ type: 'IMAGE_URL_CAPTURED', url: srcUrl })
  }

  function sendCaptured(dataUrl) {
    chrome.runtime.sendMessage({ type: 'IMAGE_CAPTURED', dataUrl })
  }
}
