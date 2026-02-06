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
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
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
