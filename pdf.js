const pdfjsPath = path => `/vendor/pdfjs/${path}`

import '@pdfjs/pdf.min.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.min.mjs')

const fetchText = async url => await (await fetch(url)).text()

let textLayerBuilderCSS = null
let annotationLayerBuilderCSS = null

// Track active render tasks per iframe document to cancel superseded renders
const activeRenderTasks = new WeakMap()
// Generation counter per document to detect stale renders after async gaps
const renderGenerations = new WeakMap()

const CONTENT_BOX_PADDING = 28
const MIN_CONTENT_CHARS = 80
const MAX_CONTENT_AREA_RATIO = 0.88
const HEADER_REGION_RATIO = 0.08
const FOOTER_REGION_RATIO = 0.80
const MIN_FOOTER_GAP = 28
const MAX_TRAILING_FOOTER_CHARS = 60

export const getPDFTextContentBox = (viewport, textContent, padding = CONTENT_BOX_PADDING) => {
    const boxes = []
    let contentChars = 0
    for (const item of textContent?.items ?? []) {
        const text = item?.str?.trim()
        if (!text) continue
        contentChars += text.length
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
        const x = tx[4]
        const y = tx[5]
        const width = Math.abs(item.width ?? 0)
        const height = Math.abs(item.height ?? Math.hypot(tx[2], tx[3]) ?? 0)
        if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) continue
        boxes.push({
            text,
            chars: text.length,
            left: x,
            top: y - height,
            right: x + width,
            bottom: y,
        })
    }
    if (contentChars < MIN_CONTENT_CHARS) return null

    const fitBoxes = getMainContentBoxes(viewport, boxes)
    if (fitBoxes.length === 0) return null

    const bounds = fitBoxes.reduce((acc, box) => ({
        left: Math.min(acc.left, box.left),
        top: Math.min(acc.top, box.top),
        right: Math.max(acc.right, box.right),
        bottom: Math.max(acc.bottom, box.bottom),
    }), {
        left: Infinity,
        top: Infinity,
        right: -Infinity,
        bottom: -Infinity,
    })
    if (!Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) return null

    const pageArea = viewport.width * viewport.height
    const contentArea = (bounds.right - bounds.left) * (bounds.bottom - bounds.top)
    if (contentArea / pageArea > MAX_CONTENT_AREA_RATIO) return null

    const x = Math.max(0, bounds.left - padding)
    const y = Math.max(0, bounds.top - padding)
    const right = Math.min(viewport.width, bounds.right + padding)
    const bottom = Math.min(viewport.height, bounds.bottom + padding)
    const width = right - x
    const height = bottom - y
    if (width <= 0 || height <= 0) return null
    return { x, y, width, height }
}

const getMainContentBoxes = (viewport, boxes) => {
    const lines = getTextLines(boxes)
    if (lines.length < 2) return boxes

    const maxLineWidth = Math.max(...lines.map(line => line.right - line.left))
    const denseLineWidth = maxLineWidth * 0.7
    const firstDenseIndex = lines.findIndex(line =>
        line.chars >= 18 && line.right - line.left >= denseLineWidth)
    let bodyStart = firstDenseIndex > 0 ? firstDenseIndex : 0
    const previous = lines[bodyStart - 1]
    const firstDense = lines[bodyStart]
    if (previous && firstDense) {
        const gap = firstDense.top - previous.bottom
        const looksLikeParagraphLead =
            previous.top > viewport.height * HEADER_REGION_RATIO &&
            previous.chars >= 8 &&
            gap >= 0 &&
            gap < MIN_FOOTER_GAP
        if (looksLikeParagraphLead) bodyStart -= 1
    }
    while (
        bodyStart < lines.length - 1 &&
        lines[bodyStart].top < viewport.height * HEADER_REGION_RATIO &&
        lines[bodyStart].boxes.length <= 1 &&
        lines[bodyStart].right - lines[bodyStart].left < maxLineWidth * 0.6
    ) {
        bodyStart += 1
    }
    if (lines[0]?.top < viewport.height * HEADER_REGION_RATIO && lines[0].boxes.length > 1) {
        bodyStart = 0
    }

    let bodyLineCount = lines.length
    for (let i = lines.length - 2; i >= 0; i--) {
        const gap = lines[i + 1].top - lines[i].bottom
        const trailing = lines.slice(i + 1)
        const trailingChars = trailing.reduce((sum, line) => sum + line.chars, 0)
        const trailingMaxWidth = Math.max(...trailing.map(line => line.right - line.left))
        const isBottomFurniture =
            lines[i + 1].top > viewport.height * FOOTER_REGION_RATIO &&
            trailingChars <= MAX_TRAILING_FOOTER_CHARS &&
            (gap >= MIN_FOOTER_GAP || trailingMaxWidth < maxLineWidth * 0.35)
        if (isBottomFurniture) {
            bodyLineCount = i + 1
            break
        }
    }

    const bodyLines = lines.slice(bodyStart, bodyLineCount)
    const bodyBoxes = bodyLines.flatMap(line => line.boxes)
    const bodyChars = bodyBoxes.reduce((sum, box) => sum + box.chars, 0)
    return bodyChars >= MIN_CONTENT_CHARS ? bodyBoxes : boxes
}

const getTextLines = boxes => {
    const lines = []
    for (const box of [...boxes].sort((a, b) => a.top - b.top || a.left - b.left)) {
            const line = lines.find(existing =>
                box.top <= existing.bottom + 2 && box.bottom >= existing.top - 2)
            if (!line) {
                lines.push({
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    chars: box.chars,
                    boxes: [box],
                })
                continue
            }
        line.left = Math.min(line.left, box.left)
        line.top = Math.min(line.top, box.top)
        line.right = Math.max(line.right, box.right)
        line.bottom = Math.max(line.bottom, box.bottom)
        line.chars += box.chars
        line.boxes.push(box)
    }
    return lines
}

// Set up panning and selection event handlers once per iframe document
const setupPanningEvents = (doc) => {
    if (doc._readiaEventsInitialized) return
    doc._readiaEventsInitialized = true

    const container = doc.querySelector('.textLayer')
    if (!container) return

    let isPanning = false
    let startX = 0
    let startY = 0
    let scrollLeft = 0
    let scrollTop = 0
    let scrollParent = null

    const findScrollableParent = (element) => {
        let current = element
        while (current) {
            if (current !== document.body && current.nodeType === 1) {
                const style = window.getComputedStyle(current)
                const overflow = style.overflow + style.overflowY + style.overflowX
                if (/(auto|scroll)/.test(overflow)) {
                    if (current.scrollHeight > current.clientHeight ||
                        current.scrollWidth > current.clientWidth) {
                        return current
                    }
                }
            }
            if (current.parentElement) {
                current = current.parentElement
            } else if (current.parentNode && current.parentNode.host) {
                current = current.parentNode.host
            } else {
                break
            }
        }
        return window
    }

    container.onpointerdown = (e) => {
        if (e.pointerType === 'touch') return
        const selection = doc.getSelection()
        const hasTextSelection = selection && selection.toString().length > 0

        const elementUnderCursor = doc.elementFromPoint(e.clientX, e.clientY)
        const hasTextUnderneath = elementUnderCursor &&
                             (elementUnderCursor.tagName === 'SPAN' || elementUnderCursor.tagName === 'P') &&
                             elementUnderCursor.textContent.trim().length > 0

        if (!hasTextUnderneath && !hasTextSelection) {
            isPanning = true
            startX = e.screenX
            startY = e.screenY

            const iframe = doc.defaultView?.frameElement
            if (iframe) {
                scrollParent = findScrollableParent(iframe)
                if (scrollParent === window) {
                    scrollLeft = window.scrollX || window.pageXOffset
                    scrollTop = window.scrollY || window.pageYOffset
                } else {
                    scrollLeft = scrollParent.scrollLeft
                    scrollTop = scrollParent.scrollTop
                }
                container.style.cursor = 'grabbing'
            }
        } else {
            container.classList.add('selecting')
        }
    }

    container.onpointermove = (e) => {
        if (isPanning && scrollParent) {
            e.preventDefault()

            const dx = e.screenX - startX
            const dy = e.screenY - startY

            if (scrollParent === window) {
                window.scrollTo(scrollLeft - dx, scrollTop - dy)
            } else {
                scrollParent.scrollLeft = scrollLeft - dx
                scrollParent.scrollTop = scrollTop - dy
            }
        }
    }

    container.onpointerup = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
            container.style.cursor = 'grab'
        } else {
            container.classList.remove('selecting')
        }
    }

    container.onpointerleave = () => {
        if (isPanning) {
            isPanning = false
            scrollParent = null
            container.style.cursor = 'grab'
        }
    }

    doc.addEventListener('selectionchange', () => {
        const selection = doc.getSelection()
        if (selection && selection.toString().length > 0) {
            container.style.cursor = 'text'
        } else if (!isPanning) {
            container.style.cursor = 'grab'
        }
    })

    container.style.cursor = 'grab'
}

const render = async (page, doc, zoom, pageColors, contentBox) => {
    if (!doc) return

    // Increment generation to invalidate any in-progress render for this doc
    const generation = (renderGenerations.get(doc) || 0) + 1
    renderGenerations.set(doc, generation)

    // Cancel any in-progress render task for this document
    const existingTask = activeRenderTasks.get(doc)
    if (existingTask) {
        existingTask.cancel()
        activeRenderTasks.delete(doc)
    }

    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--total-scale-factor', scale)
    doc.documentElement.style.setProperty('--user-unit', '1')
    doc.documentElement.style.setProperty('--scale-round-x', '1px')
    doc.documentElement.style.setProperty('--scale-round-y', '1px')
    const viewport = page.getViewport({ scale })
    const baseViewport = page.getViewport({ scale: 1 })
    const box = contentBox ?? {
        x: 0,
        y: 0,
        width: baseViewport.width,
        height: baseViewport.height,
    }
    const cropLeft = box.x * scale
    const cropTop = box.y * scale
    const cropWidth = box.width * scale
    const cropHeight = box.height * scale
    Object.assign(doc.body.style, {
        position: 'relative',
        width: `${cropWidth}px`,
        height: `${cropHeight}px`,
        overflow: 'hidden',
    })

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    const renderTask = page.render({ canvasContext, viewport, pageColors })
    activeRenderTasks.set(doc, renderTask)

    try {
        await renderTask.promise
    } catch {
        // Render was cancelled or failed — release canvas bitmap memory
        canvas.width = 0
        canvas.height = 0
        return
    } finally {
        if (activeRenderTasks.get(doc) === renderTask) {
            activeRenderTasks.delete(doc)
        }
    }

    // Bail out if a newer render has started or iframe was removed
    if (renderGenerations.get(doc) !== generation || !doc.defaultView) {
        canvas.width = 0
        canvas.height = 0
        return
    }

    const canvasElement = doc.querySelector('#canvas')
    if (!canvasElement) {
        canvas.width = 0
        canvas.height = 0
        return
    }
    Object.assign(canvasElement.style, {
        position: 'absolute',
        left: `${-cropLeft}px`,
        top: `${-cropTop}px`,
        width: `${viewport.width}px`,
        height: `${viewport.height}px`,
    })

    // Release old canvas bitmap memory before replacing
    const oldCanvas = canvasElement.querySelector('canvas')
    if (oldCanvas) {
        oldCanvas.width = 0
        oldCanvas.height = 0
    }
    canvasElement.replaceChildren(doc.adoptNode(canvas))

    void (async () => {
        try {
            // Clear text layer before re-rendering to prevent DOM accumulation
            const container = doc.querySelector('.textLayer')
            container.replaceChildren()
            Object.assign(container.style, {
                position: 'absolute',
                left: `${-cropLeft}px`,
                top: `${-cropTop}px`,
                width: `${viewport.width}px`,
                height: `${viewport.height}px`,
            })
            const textLayer = new pdfjsLib.TextLayer({
                textContentSource: await page.streamTextContent(),
                container, viewport,
            })
            await textLayer.render()

            // Bail out if superseded after async text layer render
            if (renderGenerations.get(doc) !== generation) return
            doc.dispatchEvent(new CustomEvent('readia-pdf-text-layer-rendered'))

            // hide "offscreen" canvases appended to document when rendering text layer
            // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
            for (const hiddenCanvas of document.querySelectorAll('.hiddenCanvasElement'))
                Object.assign(hiddenCanvas.style, {
                    position: 'absolute',
                    top: '0',
                    left: '0',
                    width: '0',
                    height: '0',
                    display: 'none',
                })

            // fix text selection
            // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
            const endOfContent = document.createElement('div')
            endOfContent.className = 'endOfContent'
            container.append(endOfContent)

            // Set up panning/selection event handlers once per document
            setupPanningEvents(doc)

            // Clear annotation layer before re-rendering to prevent DOM accumulation
            const div = doc.querySelector('.annotationLayer')
            div.replaceChildren()
            Object.assign(div.style, {
                position: 'absolute',
                left: `${-cropLeft}px`,
                top: `${-cropTop}px`,
                width: `${viewport.width}px`,
                height: `${viewport.height}px`,
            })
            const linkService = {
                goToDestination: () => {},
                getDestinationHash: dest => JSON.stringify(dest),
                addLinkAttributes: (link, url) => link.href = url,
            }
            await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
                annotations: await page.getAnnotations(),
            })
        } catch {}
    })()
}

const renderPage = async (page, getImageBlob, fitContent = false) => {
    const viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(blob => {
            // Release canvas bitmap memory after extracting the blob
            canvas.width = 0
            canvas.height = 0
            resolve(blob)
        }))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.css
    if (textLayerBuilderCSS == null) {
        textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))
    }
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/annotation_layer_builder.css
    if (annotationLayerBuilderCSS == null) {
        annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))
    }
    const textContent = fitContent ? await page.getTextContent() : null
    const contentBox = fitContent ? getPDFTextContentBox(viewport, textContent) : null
    const layoutViewport = contentBox ?? {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
    }
    const data = `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${layoutViewport.width}, height=${layoutViewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
            overflow: hidden;
        }
        #canvas, .textLayer, .annotationLayer { position: absolute; }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `
    const src = URL.createObjectURL(new Blob([data], { type: 'text/html' }))
    const onZoom = ({ doc, scale, pageColors }) => render(page, doc, scale, pageColors, contentBox)
    return { src, data, onZoom }
}

const escapeHTML = text => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const getTextItemBox = (viewport, item) => {
    const text = item?.str ?? ''
    if (!text.trim()) return null
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
    const x = tx[4]
    const y = tx[5]
    const width = Math.abs(item.width ?? 0)
    const height = Math.abs(item.height ?? Math.hypot(tx[2], tx[3]) ?? 0)
    if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return null
    return {
        text,
        chars: text.trim().length,
        left: x,
        top: y - height,
        right: x + width,
        bottom: y,
    }
}

const intersectsBox = (box, crop) =>
    box.right >= crop.x &&
    box.left <= crop.x + crop.width &&
    box.bottom >= crop.y &&
    box.top <= crop.y + crop.height

const renderReflowPage = async (page, fitContent = false) => {
    const viewport = page.getViewport({ scale: 1 })
    const textContent = await page.getTextContent()
    const contentBox = fitContent ? getPDFTextContentBox(viewport, textContent, 8) : null
    const boxes = []
    for (const item of textContent.items ?? []) {
        const box = getTextItemBox(viewport, item)
        if (!box) continue
        if (contentBox && !intersectsBox(box, contentBox)) continue
        boxes.push(box)
    }
    const lines = getTextLines(boxes)
        .sort((a, b) => a.top - b.top || a.left - b.left)
        .map(line => {
            const text = line.boxes
                .sort((a, b) => a.left - b.left)
                .map(box => box.text.trim())
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
            return {
                ...line,
                text,
                height: Math.max(1, line.bottom - line.top),
            }
        })
        .filter(line => /[A-Za-z]{2,}/.test(line.text))

    const paragraphs = []
    let current = ''
    let previous = null
    for (const line of lines) {
        const gap = previous ? line.top - previous.bottom : 0
        const paragraphBreak = previous && gap > Math.max(previous.height, line.height) * 1.6
        if (paragraphBreak && current.trim()) {
            paragraphs.push(current.trim())
            current = ''
        }
        if (!current) current = line.text
        else if (current.endsWith('-')) current = current.slice(0, -1) + line.text
        else current += ` ${line.text}`
        previous = line
    }
    if (current.trim()) paragraphs.push(current.trim())

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        html, body { margin: 0; padding: 0; }
        body {
            box-sizing: border-box;
            padding: 24px 22px 40px;
            font-family: Georgia, "Times New Roman", serif;
            font-size: 1.12rem;
            line-height: 1.62;
            color: CanvasText;
            background: Canvas;
            overflow-wrap: break-word;
        }
        p { margin: 0 0 1em; text-indent: 1.4em; }
        p:first-child { text-indent: 0; }
        </style>
        ${paragraphs.map(text => `<p>${escapeHTML(text)}</p>`).join('')}
    `
    return URL.createObjectURL(new Blob([html], { type: 'text/html' }))
}

const makeTOCItem = async (item, pdf) => {
    let pageIndex = undefined

    if (item.dest) {
        try {
            const dest = typeof item.dest === 'string'
                ? await pdf.getDestination(item.dest)
                : item.dest
            if (dest?.[0]) {
                pageIndex = await pdf.getPageIndex(dest[0])
            }
        } catch (e) {
            console.warn('Failed to get page index for TOC item:', item.title, e)
        }
    }

    return {
        label: item.title,
        href: item.dest ? JSON.stringify(item.dest) : '',
        index: pageIndex,
        subitems: item.items?.length
            ? await Promise.all(item.items.map(i => makeTOCItem(i, pdf)))
            : null,
    }
}

const MAX_CACHED_PAGES = 8

const CALIBRE_NS = 'http://calibre-ebook.com/xmp-namespace'
const CALIBRE_SI_NS = 'http://calibre-ebook.com/xmp-namespace-series-index'
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'

// Calibre writes series metadata into the XMP packet as
// <calibre:series rdf:parseType="Resource">
//   <rdf:value>Name</rdf:value>
//   <calibreSI:series_index>1.00</calibreSI:series_index>
// </calibre:series>
const parseCalibreSeriesFromXMP = raw => {
    if (!raw || typeof raw !== 'string') return null
    let doc
    try {
        doc = new DOMParser().parseFromString(raw, 'application/xml')
    } catch {
        return null
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) return null
    const seriesEls = doc.getElementsByTagNameNS(CALIBRE_NS, 'series')
    const seriesEl = seriesEls.item(0)
    if (!seriesEl) return null
    const valueEl = seriesEl.getElementsByTagNameNS(RDF_NS, 'value').item(0)
    const name = valueEl?.textContent?.trim()
    if (!name) return null
    const indexEl = seriesEl.getElementsByTagNameNS(CALIBRE_SI_NS, 'series_index').item(0)
    const position = indexEl?.textContent?.trim()
    return position ? { name, position } : { name }
}

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        wasmUrl: pdfjsPath(''),
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    // Get viewport dimensions from first page for fixed-layout rendering
    const firstPage = await pdf.getPage(1)
    const firstViewport = firstPage.getViewport({ scale: 1 })
    const book = { rendition: {
        layout: 'pre-paginated',
        viewport: { width: firstViewport.width, height: firstViewport.height },
    } }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const calibreSeries = parseCalibreSeriesFromXMP(metadata?.getRaw?.())
    if (calibreSeries) book.metadata.belongsTo = { series: calibreSeries }

    const outline = await pdf.getOutline()
    book.toc = outline ? await Promise.all(outline.map(item => makeTOCItem(item, pdf))) : null

    const cache = new Map()
    const pageCache = new Map()
    const getPage = async (i) => {
        const cached = pageCache.get(i)
        if (cached) {
            // Move to end for LRU ordering
            pageCache.delete(i)
            pageCache.set(i, cached)
            return cached
        }
        const page = await pdf.getPage(i + 1)
        pageCache.set(i, page)

        // Evict oldest pages when over limit, freeing internal page data
        while (pageCache.size > MAX_CACHED_PAGES) {
            const oldestKey = pageCache.keys().next().value
            const oldPage = pageCache.get(oldestKey)
            pageCache.delete(oldestKey)
            oldPage?.cleanup()
        }

        return page
    }
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cacheKey = `${i}:${book.pdfReflow ? 'reflow' : 'fixed'}:${book.pdfContentFit ? 'fit' : 'page'}`
            const cached = cache.get(cacheKey)
            if (cached) {
                // Move to end for LRU ordering
                cache.delete(cacheKey)
                cache.set(cacheKey, cached)
                return cached
            }
            const page = await getPage(i)
            const url = book.pdfReflow
                ? await renderReflowPage(page, book.pdfContentFit)
                : await renderPage(page, false, book.pdfContentFit)
            cache.set(cacheKey, url)

            // Evict oldest render results when over limit
            while (cache.size > MAX_CACHED_PAGES) {
                const oldestKey = cache.keys().next().value
                const oldEntry = cache.get(oldestKey)
                cache.delete(oldestKey)
                if (typeof oldEntry === 'string') URL.revokeObjectURL(oldEntry)
                else if (oldEntry?.src) URL.revokeObjectURL(oldEntry.src)
            }

            return url
        },
        createDocument: async () => {
            const page = await getPage(i)
            const doc = document.implementation.createHTMLDocument('')

            const canvas = doc.createElement('div')
            canvas.id = 'canvas'
            doc.body.appendChild(canvas)

            const textLayer = doc.createElement('div')
            textLayer.className = 'textLayer'
            doc.body.appendChild(textLayer)

            const annotationLayer = doc.createElement('div')
            annotationLayer.className = 'annotationLayer'
            doc.body.appendChild(annotationLayer)

            // TextLayer requires canvas 2d context for font metrics;
            // fall back to manual span construction when unavailable
            const probe = doc.createElement('canvas')
            if (probe.getContext?.('2d')) {
                const textLayerInstance = new pdfjsLib.TextLayer({
                    textContentSource: await page.streamTextContent(),
                    container: textLayer, viewport: page.getViewport({ scale: 1 }),
                })
                await textLayerInstance.render()
            } else {
                const content = await page.getTextContent()
                for (const item of content.items) {
                    if (item.str) {
                        const span = doc.createElement('span')
                        span.textContent = item.str
                        textLayer.appendChild(span)
                    }
                }
            }
            return doc
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        if (!href) return [null, null]
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        try {
            const index = await pdf.getPageIndex(dest[0])
            return [index, null]
        } catch (e) {
            console.warn('Error getting page index for href', href, e)
            return [null, null]
        }
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => {
        // Clean up all cached canvases and revoke blob URLs
        for (const [, entry] of cache) {
            if (entry?.src) URL.revokeObjectURL(entry.src)
        }
        cache.clear()
        for (const [, page] of pageCache) {
            page?.cleanup()
        }
        pageCache.clear()
        pdf.destroy()
    }
    return book
}
