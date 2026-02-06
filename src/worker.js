import ImageTracer from 'imagetracerjs'

self.onmessage = (e) => {
  const { type, id, imageData, options } = e.data

  if (type === 'convert') {
    try {
      const imgd = {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data),
      }
      const svgString = ImageTracer.imagedataToSVG(imgd, options)
      self.postMessage({ type: 'result', id, svgString })
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message })
    }
  }
}
