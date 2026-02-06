document.getElementById('pick').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !tab.id) return

  // Inject content script into the active tab
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content.js'],
  })

  // Tell the content script to start pick mode
  chrome.tabs.sendMessage(tab.id, { type: 'START_PICK' })

  // Close the popup
  window.close()
})

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') })
  window.close()
})
