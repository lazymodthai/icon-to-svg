// ── Context menu setup ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'convert-to-svg',
    title: 'Convert to SVG',
    contexts: ['image'],
  })
})

// ── Context menu click ──────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'convert-to-svg') return
  if (!info.srcUrl) return

  try {
    const dataUrl = await fetchAsDataUrl(info.srcUrl)
    await storeAndOpen(dataUrl)
  } catch (err) {
    console.error('[icon2svg] Failed to fetch image for context menu:', err)
  }
})

// ── Messages from content script ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'IMAGE_CAPTURED') {
    // Content script captured a data URL directly (same-origin image)
    storeAndOpen(msg.dataUrl)
    sendResponse({ ok: true })
  } else if (msg.type === 'IMAGE_URL_CAPTURED') {
    // Content script couldn't read the image (CORS) — fetch via background
    fetchAsDataUrl(msg.url)
      .then((dataUrl) => storeAndOpen(dataUrl))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[icon2svg] Background fetch failed:', err)
        sendResponse({ ok: false, error: err.message })
      })
    return true // keep message channel open for async response
  }
})

// ── Helpers ──────────────────────────────────────────────────────────

async function fetchAsDataUrl(url) {
  const resp = await fetch(url)
  const blob = await resp.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

async function storeAndOpen(dataUrl) {
  await chrome.storage.local.set({
    pendingImage: { dataUrl, timestamp: Date.now() },
  })
  await openConverterTab()
}

async function openConverterTab() {
  const converterUrl = chrome.runtime.getURL('index.html')
  const tabs = await chrome.tabs.query({})
  const existing = tabs.find((t) => t.url && t.url.startsWith(converterUrl))

  if (existing) {
    // Focus existing converter tab
    await chrome.tabs.update(existing.id, { active: true })
    if (existing.windowId) {
      await chrome.windows.update(existing.windowId, { focused: true })
    }
  } else {
    await chrome.tabs.create({ url: converterUrl })
  }
}
