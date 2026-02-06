// Guard against re-injection
if (!window.__icon2svg_injected) {
  window.__icon2svg_injected = true
  initIcon2Svg()
}

function initIcon2Svg() {
  let mode = null // 'pick' | 'draw'
  let overlay = null
  let highlight = null
  let toast = null
  let drawStart = null
  let selectionBox = null

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_PICK') startPick()
    if (msg.type === 'START_DRAW') startDraw()
  })

  // ── shared UI helpers ─────────────────────────────────────────────

  function createOverlay() {
    overlay = document.createElement('div')
    overlay.id = '__icon2svg_overlay'
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      cursor: 'crosshair',
      background: 'rgba(0,0,0,0.05)',
    })
    document.documentElement.appendChild(overlay)
  }

  function createToast(text) {
    toast = document.createElement('div')
    toast.id = '__icon2svg_toast'
    toast.textContent = text
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
    document.documentElement.appendChild(toast)
  }

  function cleanup() {
    mode = null
    drawStart = null
    overlay?.remove()
    highlight?.remove()
    toast?.remove()
    selectionBox?.remove()
    overlay = null
    highlight = null
    toast = null
    selectionBox = null
    document.removeEventListener('keydown', onKeyDown)
    window.__icon2svg_injected = false
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cleanup()
    }
  }

  // ── Pick Image mode ───────────────────────────────────────────────

  function startPick() {
    if (mode) cleanup()
    mode = 'pick'

    createOverlay()

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
    document.documentElement.appendChild(highlight)

    createToast('Click an image to convert to SVG  \u2022  Press Esc to cancel')

    overlay.addEventListener('mousemove', onPickMouseMove)
    overlay.addEventListener('click', onPickClick)
    document.addEventListener('keydown', onKeyDown)
  }

  function getImageElementAt(x, y) {
    overlay.style.pointerEvents = 'none'
    const el = document.elementFromPoint(x, y)
    overlay.style.pointerEvents = ''
    if (!el) return null
    if (el.tagName === 'IMG' && el.src) return el
    if (el.tagName === 'CANVAS') return el
    const bg = getComputedStyle(el).backgroundImage
    if (bg && bg !== 'none' && bg.startsWith('url(')) return el
    const childImg = el.querySelector('img[src]')
    if (childImg) return childImg
    return null
  }

  function onPickMouseMove(e) {
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

  function onPickClick(e) {
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
        chrome.runtime.sendMessage({ type: 'IMAGE_CAPTURED', dataUrl })
        return
      } catch {
        // tainted canvas — fall through
      }
    }

    let srcUrl = null
    if (el.tagName === 'IMG') {
      srcUrl = el.src
    } else {
      const bg = getComputedStyle(el).backgroundImage
      const match = bg.match(/url\(["']?(.*?)["']?\)/)
      if (match) srcUrl = match[1]
    }
    if (!srcUrl) return

    if (el.tagName === 'IMG') {
      try {
        const c = document.createElement('canvas')
        c.width = el.naturalWidth || el.width
        c.height = el.naturalHeight || el.height
        const ctx = c.getContext('2d')
        ctx.drawImage(el, 0, 0)
        const dataUrl = c.toDataURL('image/png')
        chrome.runtime.sendMessage({ type: 'IMAGE_CAPTURED', dataUrl })
        return
      } catch {
        // tainted canvas — fall through
      }
    }

    chrome.runtime.sendMessage({ type: 'IMAGE_URL_CAPTURED', url: srcUrl })
  }

  // ── Draw Area mode ────────────────────────────────────────────────

  function startDraw() {
    if (mode) cleanup()
    mode = 'draw'

    createOverlay()

    selectionBox = document.createElement('div')
    selectionBox.id = '__icon2svg_selection'
    Object.assign(selectionBox.style, {
      position: 'fixed',
      border: '2px dashed #6ab0f3',
      background: 'rgba(106,176,243,0.12)',
      zIndex: '2147483647',
      pointerEvents: 'none',
      display: 'none',
    })
    document.documentElement.appendChild(selectionBox)

    createToast('Click and drag to select an area  \u2022  Press Esc to cancel')

    overlay.addEventListener('mousedown', onDrawMouseDown)
    overlay.addEventListener('mousemove', onDrawMouseMove)
    overlay.addEventListener('mouseup', onDrawMouseUp)
    document.addEventListener('keydown', onKeyDown)
  }

  function onDrawMouseDown(e) {
    e.preventDefault()
    drawStart = { x: e.clientX, y: e.clientY }
    Object.assign(selectionBox.style, {
      display: 'block',
      left: e.clientX + 'px',
      top: e.clientY + 'px',
      width: '0px',
      height: '0px',
    })
  }

  function onDrawMouseMove(e) {
    if (!drawStart) return
    const x = Math.min(drawStart.x, e.clientX)
    const y = Math.min(drawStart.y, e.clientY)
    const w = Math.abs(e.clientX - drawStart.x)
    const h = Math.abs(e.clientY - drawStart.y)
    Object.assign(selectionBox.style, {
      left: x + 'px',
      top: y + 'px',
      width: w + 'px',
      height: h + 'px',
    })
  }

  function onDrawMouseUp(e) {
    if (!drawStart) return
    const x = Math.min(drawStart.x, e.clientX)
    const y = Math.min(drawStart.y, e.clientY)
    const w = Math.abs(e.clientX - drawStart.x)
    const h = Math.abs(e.clientY - drawStart.y)
    drawStart = null

    if (w < 4 || h < 4) return // too small, ignore

    // Account for device pixel ratio for the screenshot crop
    const dpr = window.devicePixelRatio || 1

    cleanup()

    // Send rect to background for screenshot + crop
    chrome.runtime.sendMessage({
      type: 'AREA_SELECTED',
      rect: {
        x: Math.round(x * dpr),
        y: Math.round(y * dpr),
        w: Math.round(w * dpr),
        h: Math.round(h * dpr),
      },
    })
  }
}
