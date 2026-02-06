const TARGET_SIZE = 512

/**
 * Remove empty paths and paths with bounding-box area < minArea.
 * Round all floating-point path coordinates to `decimals` places.
 */
export function optimizeSvg(svgStr, minArea = 2, decimals = 2) {
  return svgStr.replace(/<path[^>]*?\/?>/g, (pathEl) => {
    const dMatch = pathEl.match(/\bd="([^"]*)"/)
    if (!dMatch) return ''
    const d = dMatch[1].trim()
    if (!d || d === 'M 0 0') return ''
    if (getPathBBoxArea(d) < minArea) return ''
    const rounded = roundCoords(d, decimals)
    return pathEl.replace(dMatch[0], `d="${rounded}"`)
  })
}

/**
 * Rewrite the SVG so its viewBox is 0 0 512 512, content centred and
 * uniformly scaled to fit without clipping.
 */
export function normalizeSvg(svgStr, targetSize = TARGET_SIZE) {
  const wM = svgStr.match(/width="(\d+\.?\d*)"/)
  const hM = svgStr.match(/height="(\d+\.?\d*)"/)
  if (!wM || !hM) return svgStr

  const origW = parseFloat(wM[1])
  const origH = parseFloat(hM[1])
  const scale = targetSize / Math.max(origW, origH)
  const tx = r((targetSize - origW * scale) / 2)
  const ty = r((targetSize - origH * scale) / 2)

  let out = svgStr
    .replace(/width="[^"]*"/, `width="${targetSize}"`)
    .replace(/height="[^"]*"/, `height="${targetSize}"`)

  if (/viewBox/.test(out)) {
    out = out.replace(/viewBox="[^"]*"/, `viewBox="0 0 ${targetSize} ${targetSize}"`)
  } else {
    out = out.replace('<svg ', `<svg viewBox="0 0 ${targetSize} ${targetSize}" `)
  }

  out = out.replace(
    /(<svg[^>]*>)/,
    `$1<g transform="translate(${tx},${ty}) scale(${r(scale)})">`,
  )
  out = out.replace('</svg>', '</g></svg>')
  return out
}

/**
 * Douglas-Peucker simplification on sequences of L (lineTo) commands.
 */
export function simplifyPaths(svgStr, tolerance = 0.5) {
  return svgStr.replace(/\bd="([^"]*)"/g, (_m, d) => `d="${simplifyD(d, tolerance)}"`)
}

/**
 * Return an array of unique fill colours found in the SVG.
 */
export function extractColors(svgStr) {
  const set = new Set()
  const re = /fill="([^"]+)"/g
  let m
  while ((m = re.exec(svgStr))) {
    const c = m[1].toLowerCase()
    if (c !== 'none' && c !== 'transparent') set.add(c)
  }
  return [...set]
}

/**
 * Replace fill colours according to { oldColor: newColor }.
 */
export function recolorSvg(svgStr, colorMap) {
  let out = svgStr
  for (const [orig, next] of Object.entries(colorMap)) {
    out = out.replace(new RegExp(`fill="${esc(orig)}"`, 'gi'), `fill="${next}"`)
  }
  return out
}

/**
 * Prepare an SVG for Figma import:
 *  – remove explicit width / height (Figma reads viewBox)
 *  – group <path>s by fill colour
 */
export function prepareFigmaExport(svgStr) {
  let out = svgStr
    .replace(/\s+width="[^"]*"/, '')
    .replace(/\s+height="[^"]*"/, '')

  // Collect paths
  const paths = []
  const pRe = /<path[^>]*?\/?>/g
  let m
  while ((m = pRe.exec(out))) {
    const fM = m[0].match(/fill="([^"]*)"/)
    paths.push({ el: m[0], fill: fM ? fM[1] : 'none' })
  }

  // Strip all paths from the SVG shell
  let shell = out.replace(/<path[^>]*?\/?>/g, '')

  // Group by fill
  const groups = {}
  for (const p of paths) {
    ;(groups[p.fill] ??= []).push(p.el.replace(/\s*fill="[^"]*"/, ''))
  }

  let grouped = ''
  for (const [fill, els] of Object.entries(groups)) {
    grouped += `<g fill="${fill}">\n${els.join('\n')}\n</g>\n`
  }

  // Insert before closing tags
  if (shell.includes('</g></svg>')) {
    shell = shell.replace('</g></svg>', `${grouped}</g></svg>`)
  } else {
    shell = shell.replace('</svg>', `${grouped}</svg>`)
  }
  return shell
}

// ── helpers ──────────────────────────────────────────────────────────

function getPathBBoxArea(d) {
  const nums = d.match(/-?\d+\.?\d*/g)
  if (!nums || nums.length < 4) return 0
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (let i = 0; i < nums.length - 1; i += 2) {
    const x = +nums[i]
    const y = +nums[i + 1]
    if (isFinite(x) && isFinite(y)) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return isFinite(minX) ? (maxX - minX) * (maxY - minY) : 0
}

function roundCoords(d, dec) {
  return d.replace(/-?\d+\.\d+/g, (n) =>
    parseFloat(parseFloat(n).toFixed(dec)).toString(),
  )
}

function r(n) {
  return parseFloat(n.toFixed(2))
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Douglas-Peucker ─────────────────────────────────────────────────

function simplifyD(d, tol) {
  const cmds = parseCmds(d)
  if (cmds.length < 3) return d

  const out = []
  let i = 0
  while (i < cmds.length) {
    if (cmds[i].t === 'L') {
      // gather consecutive L-commands into a polyline
      const pts = []
      // preceding point (from last command)
      if (out.length) {
        const prev = out[out.length - 1]
        if (prev.a.length >= 2) pts.push([prev.a[prev.a.length - 2], prev.a[prev.a.length - 1]])
      }
      while (i < cmds.length && cmds[i].t === 'L') {
        pts.push([cmds[i].a[0], cmds[i].a[1]])
        i++
      }
      const simple = pts.length > 2 ? dp(pts, tol) : pts
      const skip = out.length ? 1 : 0
      for (let j = skip; j < simple.length; j++) {
        out.push({ t: 'L', a: simple[j] })
      }
    } else {
      out.push(cmds[i])
      i++
    }
  }
  return out.map((c) => `${c.t} ${c.a.join(' ')}`).join(' ')
}

function parseCmds(d) {
  const res = []
  const re = /([MLQCSTAZHVmlqcstahvz])\s*([-\d.,eE\s]*)/g
  let m
  while ((m = re.exec(d))) {
    const a = m[2].trim()
    res.push({ t: m[1], a: a ? a.split(/[\s,]+/).map(Number) : [] })
  }
  return res
}

function dp(pts, tol) {
  if (pts.length <= 2) return pts
  let maxD = 0,
    maxI = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pDist(pts[i], pts[0], pts[pts.length - 1])
    if (d > maxD) {
      maxD = d
      maxI = i
    }
  }
  if (maxD > tol) {
    const l = dp(pts.slice(0, maxI + 1), tol)
    const rt = dp(pts.slice(maxI), tol)
    return [...l.slice(0, -1), ...rt]
  }
  return [pts[0], pts[pts.length - 1]]
}

function pDist([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1,
    dy = y2 - y1,
    lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(x - x1, y - y1)
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / Math.sqrt(lenSq)
}
