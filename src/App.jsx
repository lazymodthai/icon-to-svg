import { useState, useEffect, useRef, useCallback } from 'react'
import JSZip from 'jszip'
import {
  optimizeSvg,
  normalizeSvg,
  simplifyPaths,
  extractColors,
  recolorSvg,
  prepareFigmaExport,
} from './svgUtils'

const DEFAULT_COLORS = 6
const DEFAULT_SMOOTHNESS = 1
const TARGET_SIZE = 512
const isExtension =
  typeof chrome !== 'undefined' && !!chrome.storage?.local

let _id = 0
const uid = () => `f${++_id}`

// ── helpers ──────────────────────────────────────────────────────────

function loadImageData(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      resolve(ctx.getImageData(0, 0, c.width, c.height))
    }
    img.src = dataUrl
  })
}

function cropImageDataUrl(dataUrl, rect) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = rect.w
      c.height = rect.h
      const ctx = c.getContext('2d')
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
      resolve(ctx.getImageData(0, 0, rect.w, rect.h))
    }
    img.src = dataUrl
  })
}

function canvasToDataUrl(imageData) {
  const c = document.createElement('canvas')
  c.width = imageData.width
  c.height = imageData.height
  const ctx = c.getContext('2d')
  ctx.putImageData(imageData, 0, 0)
  return c.toDataURL('image/png')
}

function removeBackground(imageData, tolerance = 30) {
  const { width, height } = imageData
  const data = new Uint8ClampedArray(imageData.data)

  // Sample the 4 corner pixels to determine background color
  const getPixel = (x, y) => {
    const i = (y * width + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }

  const corners = [
    getPixel(0, 0),
    getPixel(width - 1, 0),
    getPixel(0, height - 1),
    getPixel(width - 1, height - 1),
  ]

  // Use the most common corner color as the background
  const colorKey = (c) => `${c[0]},${c[1]},${c[2]}`
  const counts = {}
  for (const c of corners) {
    const k = colorKey(c)
    counts[k] = (counts[k] || 0) + 1
  }
  let bgColor = corners[0]
  let maxCount = 0
  for (const c of corners) {
    const k = colorKey(c)
    if (counts[k] > maxCount) {
      maxCount = counts[k]
      bgColor = c
    }
  }

  const matches = (x, y) => {
    const i = (y * width + x) * 4
    return (
      Math.abs(data[i] - bgColor[0]) <= tolerance &&
      Math.abs(data[i + 1] - bgColor[1]) <= tolerance &&
      Math.abs(data[i + 2] - bgColor[2]) <= tolerance &&
      data[i + 3] > 0
    )
  }

  // Flood-fill from all 4 corners
  const visited = new Uint8Array(width * height)
  const queue = []
  const startPoints = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]

  for (const [sx, sy] of startPoints) {
    if (visited[sy * width + sx] || !matches(sx, sy)) continue
    queue.push(sx, sy)
    visited[sy * width + sx] = 1
  }

  while (queue.length > 0) {
    const y = queue.pop()
    const x = queue.pop()
    // Make transparent
    const i = (y * width + x) * 4
    data[i + 3] = 0

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
      const ni = ny * width + nx
      if (visited[ni]) continue
      visited[ni] = 1
      if (matches(nx, ny)) {
        queue.push(nx, ny)
      }
    }
  }

  return new ImageData(data, width, height)
}

function postProcess(svgStr) {
  let s = optimizeSvg(svgStr)
  s = simplifyPaths(s)
  s = normalizeSvg(s, TARGET_SIZE)
  return s
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

// ── themes ───────────────────────────────────────────────────────────

const light = {
  bg: '#ffffff',
  surface: '#f5f5f5',
  text: '#222',
  textSec: '#666',
  border: '#ddd',
  accent: '#4a90d9',
  accentHover: '#3a7bc8',
  dropBg: '#fafafa',
  dropActive: '#e8f0fe',
  card: '#fff',
}

const dark = {
  bg: '#131320',
  surface: '#1b1b30',
  text: '#e0e0e0',
  textSec: '#999',
  border: '#2e2e4a',
  accent: '#6ab0f3',
  accentHover: '#5a9ee3',
  dropBg: '#1a1a30',
  dropActive: '#252548',
  card: '#1e1e36',
}

// ── App ──────────────────────────────────────────────────────────────

export default function App() {
  const [files, setFiles] = useState([])
  const [numColors, setNumColors] = useState(DEFAULT_COLORS)
  const [smoothness, setSmoothness] = useState(DEFAULT_SMOOTHNESS)
  const [darkMode, setDarkMode] = useState(
    () => localStorage.getItem('icon2svg_dark') === '1',
  )
  const [recolorMaps, setRecolorMaps] = useState({})
  const [dragOver, setDragOver] = useState(false)
  const [cropTarget, setCropTarget] = useState(null) // file id being cropped
  const inputRef = useRef(null)
  const workerRef = useRef(null)
  const debounceRef = useRef(null)

  const t = darkMode ? dark : light

  // ── worker lifecycle ───────────────────────────────────────────────

  useEffect(() => {
    const w = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    })
    w.onmessage = (e) => {
      const { type, id, svgString, error } = e.data
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== id) return f
          if (type === 'result') {
            const processed = postProcess(svgString)
            return {
              ...f,
              svgString: processed,
              colors: extractColors(processed),
              converting: false,
            }
          }
          return { ...f, converting: false, error }
        }),
      )
      // clear recolor when reconverting
      if (type === 'result') {
        setRecolorMaps((m) => {
          const next = { ...m }
          delete next[id]
          return next
        })
      }
    }
    workerRef.current = w
    return () => w.terminate()
  }, [])

  // ── dark mode persistence ──────────────────────────────────────────

  useEffect(() => {
    localStorage.setItem('icon2svg_dark', darkMode ? '1' : '0')
  }, [darkMode])

  // ── import a data URL (from extension pick / context menu) ────────

  const importDataUrl = useCallback(
    async (dataUrl, name = 'picked-image') => {
      const imageData = await loadImageData(dataUrl)
      const entry = {
        id: uid(),
        name,
        originalSrc: dataUrl,
        imageData,
        svgString: null,
        converting: true,
        colors: [],
      }
      setFiles((prev) => [...prev, entry])
      workerRef.current?.postMessage({
        type: 'convert',
        id: entry.id,
        imageData: {
          data: imageData.data,
          width: imageData.width,
          height: imageData.height,
        },
        options: {
          numberofcolors: numColors,
          pathomit: 8,
          ltres: smoothness,
          qtres: smoothness,
          scale: 1,
          strokewidth: 0,
        },
      })
    },
    [numColors, smoothness],
  )

  // ── chrome extension: pending image from storage ──────────────────

  useEffect(() => {
    if (!isExtension) return

    // Check for pending image on mount
    chrome.storage.local.get('pendingImage', (result) => {
      if (result.pendingImage?.dataUrl) {
        importDataUrl(result.pendingImage.dataUrl)
        chrome.storage.local.remove('pendingImage')
      }
    })

    // Listen for new pending images while tab is open
    const onChanged = (changes) => {
      if (changes.pendingImage?.newValue?.dataUrl) {
        importDataUrl(changes.pendingImage.newValue.dataUrl)
        chrome.storage.local.remove('pendingImage')
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [importDataUrl])

  // ── convert a single file via worker ───────────────────────────────

  const convertFile = useCallback(
    (file) => {
      if (!file.imageData || !workerRef.current) return
      setFiles((prev) =>
        prev.map((f) => (f.id === file.id ? { ...f, converting: true } : f)),
      )
      workerRef.current.postMessage({
        type: 'convert',
        id: file.id,
        imageData: {
          data: file.imageData.data,
          width: file.imageData.width,
          height: file.imageData.height,
        },
        options: {
          numberofcolors: numColors,
          pathomit: 8,
          ltres: smoothness,
          qtres: smoothness,
          scale: 1,
          strokewidth: 0,
        },
      })
    },
    [numColors, smoothness],
  )

  // ── reconvert all on slider change (debounced) ─────────────────────

  useEffect(() => {
    if (!files.length) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      files.forEach((f) => {
        if (f.imageData) convertFile(f)
      })
    }, 300)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numColors, smoothness])

  // ── file ingestion ─────────────────────────────────────────────────

  const addFiles = useCallback(
    async (fileList) => {
      const accepted = [...fileList].filter((f) =>
        /^image\/(png|jpe?g)$/.test(f.type),
      )
      if (!accepted.length) return

      const entries = await Promise.all(
        accepted.map(async (file) => {
          const dataUrl = await readAsDataUrl(file)
          const imageData = await loadImageData(dataUrl)
          const name = file.name.replace(/\.[^.]+$/, '')
          return { id: uid(), name, originalSrc: dataUrl, imageData, svgString: null, converting: false, colors: [] }
        }),
      )

      setFiles((prev) => [...prev, ...entries])

      // auto-convert
      entries.forEach((entry) => {
        if (!workerRef.current) return
        setFiles((prev) =>
          prev.map((f) => (f.id === entry.id ? { ...f, converting: true } : f)),
        )
        workerRef.current.postMessage({
          type: 'convert',
          id: entry.id,
          imageData: {
            data: entry.imageData.data,
            width: entry.imageData.width,
            height: entry.imageData.height,
          },
          options: {
            numberofcolors: numColors,
            pathomit: 8,
            ltres: smoothness,
            qtres: smoothness,
            scale: 1,
            strokewidth: 0,
          },
        })
      })
    },
    [numColors, smoothness],
  )

  // ── event handlers ─────────────────────────────────────────────────

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    addFiles(e.dataTransfer.files)
  }
  const onDragOver = (e) => {
    e.preventDefault()
    setDragOver(true)
  }
  const onDragLeave = () => setDragOver(false)
  const onFileInput = (e) => {
    addFiles(e.target.files)
    e.target.value = ''
  }

  const handleReset = () => {
    setFiles([])
    setRecolorMaps({})
    setNumColors(DEFAULT_COLORS)
    setSmoothness(DEFAULT_SMOOTHNESS)
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleConvertAll = () => {
    files.forEach((f) => {
      if (f.imageData) convertFile(f)
    })
  }

  // ── get display SVG (with recoloring applied) ──────────────────────

  const getDisplaySvg = (file) => {
    if (!file.svgString) return null
    const map = recolorMaps[file.id]
    return map ? recolorSvg(file.svgString, map) : file.svgString
  }

  // ── downloads ──────────────────────────────────────────────────────

  const downloadSvg = (file, figma = false) => {
    let svg = getDisplaySvg(file)
    if (!svg) return
    if (figma) svg = prepareFigmaExport(svg)
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${file.name}.svg`)
  }

  const downloadAllZip = async (figma = false) => {
    const zip = new JSZip()
    files.forEach((f) => {
      let svg = getDisplaySvg(f)
      if (!svg) return
      if (figma) svg = prepareFigmaExport(svg)
      zip.file(`${f.name}.svg`, svg)
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, figma ? 'icons-figma.zip' : 'icons.zip')
  }

  // ── recolor handler ────────────────────────────────────────────────

  const onColorChange = (fileId, origColor, newColor) => {
    setRecolorMaps((prev) => ({
      ...prev,
      [fileId]: { ...(prev[fileId] || {}), [origColor]: newColor },
    }))
  }

  // ── crop handler ──────────────────────────────────────────────────

  const handleCropConfirm = useCallback(
    async (fileId, rect) => {
      // rect = { x, y, w, h } in original image pixel coords
      const file = files.find((f) => f.id === fileId)
      if (!file) return

      const croppedData = await cropImageDataUrl(file.originalSrc, rect)
      const croppedSrc = canvasToDataUrl(croppedData)

      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, originalSrc: croppedSrc, imageData: croppedData, svgString: null, converting: true, colors: [] }
            : f,
        ),
      )
      setRecolorMaps((m) => {
        const next = { ...m }
        delete next[fileId]
        return next
      })
      setCropTarget(null)

      workerRef.current?.postMessage({
        type: 'convert',
        id: fileId,
        imageData: {
          data: croppedData.data,
          width: croppedData.width,
          height: croppedData.height,
        },
        options: {
          numberofcolors: numColors,
          pathomit: 8,
          ltres: smoothness,
          qtres: smoothness,
          scale: 1,
          strokewidth: 0,
        },
      })
    },
    [files, numColors, smoothness],
  )

  // ── remove background handler ─────────────────────────────────────

  const handleRemoveBg = useCallback(
    (fileId) => {
      const file = files.find((f) => f.id === fileId)
      if (!file?.imageData) return

      const cleaned = removeBackground(file.imageData)
      const cleanedSrc = canvasToDataUrl(cleaned)

      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, originalSrc: cleanedSrc, imageData: cleaned, svgString: null, converting: true, colors: [] }
            : f,
        ),
      )
      setRecolorMaps((m) => {
        const next = { ...m }
        delete next[fileId]
        return next
      })

      workerRef.current?.postMessage({
        type: 'convert',
        id: fileId,
        imageData: {
          data: cleaned.data,
          width: cleaned.width,
          height: cleaned.height,
        },
        options: {
          numberofcolors: numColors,
          pathomit: 8,
          ltres: smoothness,
          qtres: smoothness,
          scale: 1,
          strokewidth: 0,
        },
      })
    },
    [files, numColors, smoothness],
  )

  // ── computed ───────────────────────────────────────────────────────

  const hasConverted = files.some((f) => f.svgString)
  const isConverting = files.some((f) => f.converting)

  // ── render ─────────────────────────────────────────────────────────

  return (
    <div style={{ background: t.bg, color: t.text, minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* header */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: `1px solid ${t.border}` }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Flat Icon &rarr; SVG Converter</h1>
        <button onClick={() => setDarkMode((d) => !d)} style={btnStyle(t, true)} title="Toggle dark mode">
          {darkMode ? 'Light' : 'Dark'}
        </button>
      </header>

      <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ─── left column ─── */}
        <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* drop zone */}
          <div
            style={{
              border: `2px dashed ${dragOver ? t.accent : t.border}`,
              borderRadius: 12,
              padding: '36px 16px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? t.dropActive : t.dropBg,
              transition: 'border-color .2s, background .2s',
            }}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => inputRef.current?.click()}
          >
            <p style={{ margin: 0, fontSize: 14, color: t.textSec }}>
              Drag &amp; drop PNG/JPG icons here
              <br />
              or click to select
            </p>
            <input ref={inputRef} type="file" accept="image/png,image/jpeg" multiple onChange={onFileInput} style={{ display: 'none' }} />
          </div>

          {/* color slider */}
          <div style={{ background: t.surface, borderRadius: 10, padding: 16 }}>
            <label style={{ fontSize: 13, color: t.textSec, display: 'block', marginBottom: 6 }}>
              Number of colours: <strong style={{ color: t.text }}>{numColors}</strong>
            </label>
            <input
              type="range"
              min={2}
              max={12}
              value={numColors}
              onChange={(e) => setNumColors(+e.target.value)}
              style={{ width: '100%', accentColor: t.accent }}
            />
          </div>

          {/* smoothness slider */}
          <div style={{ background: t.surface, borderRadius: 10, padding: 16 }}>
            <label style={{ fontSize: 13, color: t.textSec, display: 'block', marginBottom: 6 }}>
              Edge smoothness: <strong style={{ color: t.text }}>{smoothness}</strong>
            </label>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={smoothness}
              onChange={(e) => setSmoothness(+e.target.value)}
              style={{ width: '100%', accentColor: t.accent }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: t.textSec, marginTop: 4 }}>
              <span>Sharp</span>
              <span>Smooth</span>
            </div>
          </div>

          {/* buttons */}
          <button onClick={handleConvertAll} disabled={!files.length || isConverting} style={btnStyle(t)}>
            {isConverting ? 'Converting\u2026' : 'Convert All'}
          </button>

          {hasConverted && (
            <>
              <button onClick={() => downloadAllZip(false)} style={btnStyle(t)}>
                Download All as ZIP
              </button>
              <button onClick={() => downloadAllZip(true)} style={btnStyle(t, true)}>
                Download All for Figma (ZIP)
              </button>
            </>
          )}

          <button onClick={handleReset} style={{ ...btnStyle(t, true), color: '#e55', borderColor: '#e55' }}>
            Reset
          </button>
        </div>

        {/* ─── right column ─── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {files.length === 0 && (
            <p style={{ color: t.textSec, textAlign: 'center', marginTop: 48, fontSize: 15 }}>
              Upload icons to get started.
            </p>
          )}

          {files.map((f) => {
            const displaySvg = getDisplaySvg(f)
            return (
              <div key={f.id} style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 12, padding: 16 }}>
                <p style={{ margin: '0 0 10px', fontWeight: 500, fontSize: 14 }}>{f.name}</p>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  {/* original */}
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: t.textSec, marginBottom: 4 }}>Original</div>
                    <img src={f.originalSrc} alt={f.name} style={{ width: 128, height: 128, objectFit: 'contain', border: `1px solid ${t.border}`, borderRadius: 6, background: '#fff' }} />
                  </div>

                  {/* svg preview */}
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: t.textSec, marginBottom: 4 }}>SVG</div>
                    {f.converting ? (
                      <div style={{ width: 128, height: 128, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${t.border}`, borderRadius: 6, background: '#fff' }}>
                        <Spinner />
                      </div>
                    ) : displaySvg ? (
                      <div
                        style={{ width: 128, height: 128, border: `1px solid ${t.border}`, borderRadius: 6, background: '#fff', overflow: 'hidden' }}
                        dangerouslySetInnerHTML={{ __html: scaleSvgPreview(displaySvg, 128) }}
                      />
                    ) : (
                      <div style={{ width: 128, height: 128, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${t.border}`, borderRadius: 6, color: t.textSec, fontSize: 12, background: '#fff' }}>
                        Not converted
                      </div>
                    )}
                  </div>

                  {/* actions when not yet converted */}
                  {!displaySvg && (
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, paddingBottom: 4 }}>
                      <button onClick={() => setCropTarget(f.id)} style={smallBtn(t)}>Draw area</button>
                      <button onClick={() => handleRemoveBg(f.id)} style={smallBtn(t)}>Remove BG</button>
                    </div>
                  )}

                  {/* colours + actions */}
                  {displaySvg && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 140 }}>
                      <div style={{ fontSize: 11, color: t.textSec }}>Recolour</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(f.colors || []).map((c) => {
                          const mapped = recolorMaps[f.id]?.[c] || c
                          return (
                            <label key={c} style={{ position: 'relative', cursor: 'pointer' }} title={`${c} → ${mapped}`}>
                              <div style={{ width: 24, height: 24, borderRadius: 4, background: mapped, border: `2px solid ${t.border}` }} />
                              <input
                                type="color"
                                value={toHex6(mapped)}
                                onChange={(e) => onColorChange(f.id, c, e.target.value)}
                                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
                              />
                            </label>
                          )
                        })}
                      </div>

                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        <button onClick={() => downloadSvg(f)} style={smallBtn(t)}>Download</button>
                        <button onClick={() => downloadSvg(f, true)} style={smallBtn(t)}>Figma</button>
                        <button onClick={() => setCropTarget(f.id)} style={smallBtn(t)}>Draw area</button>
                        <button onClick={() => handleRemoveBg(f.id)} style={smallBtn(t)}>Remove BG</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* crop modal */}
      {cropTarget && (() => {
        const file = files.find((f) => f.id === cropTarget)
        if (!file) return null
        return (
          <CropModal
            src={file.originalSrc}
            theme={t}
            onConfirm={(rect) => handleCropConfirm(cropTarget, rect)}
            onCancel={() => setCropTarget(null)}
          />
        )
      })()}
    </div>
  )
}

// ── tiny components ──────────────────────────────────────────────────

function Spinner() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" style={{ animation: 'spin 0.8s linear infinite' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <circle cx="14" cy="14" r="11" fill="none" stroke="#4a90d9" strokeWidth="3" strokeDasharray="50 20" />
    </svg>
  )
}

// ── crop modal ───────────────────────────────────────────────────────

function CropModal({ src, theme: t, onConfirm, onCancel }) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)
  const [drawing, setDrawing] = useState(false)
  const [start, setStart] = useState(null)
  const [rect, setRect] = useState(null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [scale, setScale] = useState(1)

  // Load image to get natural dimensions
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imgRef.current = img

      // Fit image into modal (max 80vw x 70vh)
      const maxW = window.innerWidth * 0.8
      const maxH = window.innerHeight * 0.7
      const s = Math.min(1, maxW / img.width, maxH / img.height)
      setScale(s)
      setImgLoaded(true)
    }
    img.src = src
  }, [src])

  // Draw canvas whenever rect changes
  useEffect(() => {
    if (!imgLoaded || !canvasRef.current || !imgRef.current) return
    const canvas = canvasRef.current
    const img = imgRef.current
    const ctx = canvas.getContext('2d')

    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    if (rect) {
      // Dim outside the selection
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Clear the selected region to show the image
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      // Re-dim outside (using clip)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, canvas.width, canvas.height)
      ctx.rect(rect.x, rect.y, rect.w, rect.h)
      ctx.clip('evenodd')
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()

      // Selection border
      ctx.strokeStyle = '#6ab0f3'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
      ctx.setLineDash([])
    }
  }, [imgLoaded, rect, scale])

  const onMouseDown = (e) => {
    const r = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    setStart({ x, y })
    setRect(null)
    setDrawing(true)
  }

  const onMouseMove = (e) => {
    if (!drawing || !start) return
    const r = canvasRef.current.getBoundingClientRect()
    const cx = Math.max(0, Math.min(e.clientX - r.left, r.width))
    const cy = Math.max(0, Math.min(e.clientY - r.top, r.height))
    setRect({
      x: Math.min(start.x, cx),
      y: Math.min(start.y, cy),
      w: Math.abs(cx - start.x),
      h: Math.abs(cy - start.y),
    })
  }

  const onMouseUp = () => {
    setDrawing(false)
  }

  const handleConfirm = () => {
    if (!rect || rect.w < 2 || rect.h < 2) return
    // Convert display coords back to original image coords
    onConfirm({
      x: Math.round(rect.x / scale),
      y: Math.round(rect.y / scale),
      w: Math.round(rect.w / scale),
      h: Math.round(rect.h / scale),
    })
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') handleConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <div style={{ marginBottom: 12, fontSize: 14, color: '#e0e0e0' }}>
        Draw a rectangle around the area to convert. Press Esc to cancel.
      </div>
      {imgLoaded && (
        <canvas
          ref={canvasRef}
          onMouseDown={onMouseDown}
          style={{ cursor: 'crosshair', borderRadius: 6, border: `2px solid ${t.border}` }}
        />
      )}
      <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
        <button
          onClick={handleConfirm}
          disabled={!rect || rect.w < 2 || rect.h < 2}
          style={{
            ...smallBtn(t),
            padding: '8px 24px', fontSize: 14,
            opacity: (!rect || rect.w < 2) ? 0.4 : 1,
          }}
        >
          Crop &amp; Convert
        </button>
        <button onClick={onCancel} style={{ ...smallBtn(t), padding: '8px 24px', fontSize: 14, borderColor: '#e55', color: '#e55' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── style helpers ────────────────────────────────────────────────────

function btnStyle(t, outline = false) {
  return {
    padding: '9px 0',
    fontSize: 14,
    fontWeight: 500,
    border: outline ? `1.5px solid ${t.accent}` : 'none',
    borderRadius: 8,
    cursor: 'pointer',
    background: outline ? 'transparent' : t.accent,
    color: outline ? t.accent : '#fff',
    width: '100%',
    textAlign: 'center',
  }
}

function smallBtn(t) {
  return {
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 500,
    border: `1px solid ${t.accent}`,
    borderRadius: 6,
    cursor: 'pointer',
    background: 'transparent',
    color: t.accent,
  }
}

// ── util ─────────────────────────────────────────────────────────────

function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = (e) => resolve(e.target.result)
    r.readAsDataURL(file)
  })
}

/** Scale the SVG element dimensions for inline preview. */
function scaleSvgPreview(svgStr, size) {
  return svgStr
    .replace(/width="[^"]*"/, `width="${size}"`)
    .replace(/height="[^"]*"/, `height="${size}"`)
}

/** Convert any CSS colour string to #rrggbb for <input type=color>. */
function toHex6(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color
  // use a temporary element to resolve named / rgb(...) colours
  const el = document.createElement('span')
  el.style.color = color
  document.body.appendChild(el)
  const computed = getComputedStyle(el).color
  document.body.removeChild(el)
  const m = computed.match(/\d+/g)
  if (!m) return '#000000'
  return (
    '#' +
    m
      .slice(0, 3)
      .map((n) => (+n).toString(16).padStart(2, '0'))
      .join('')
  )
}
