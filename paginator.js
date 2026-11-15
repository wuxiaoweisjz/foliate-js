const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const LOAD_EVENT_WAIT_TIMEOUT_MS = 5000
const PREPARE_RELOCATE_WAIT_TIMEOUT_MS = 200
const SECTION_LOAD_TIMEOUT_MS = 5000
const IFRAME_LOAD_TIMEOUT_MS = 10000

const withTimeout = (task, timeoutMs, label) => {
    let timeout
    const pending = Promise.resolve(task)
    void pending.catch(() => {})
    return Promise.race([
        pending,
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(
                new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
    ]).finally(() => clearTimeout(timeout))
}

const waitForAnimationFrame = () => new Promise(resolve => {
    let settled = false
    const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
    }
    const timeout = setTimeout(finish, 32)
    requestAnimationFrame(finish)
})

const dispatchExtendableLoadEvent = async (target, detail) => {
    const pending = []
    const extendedDetail = {
        ...detail,
        waitUntil: task => {
            if (task?.then) pending.push(Promise.resolve(task))
        },
    }
    target.dispatchEvent(new CustomEvent('load', { detail: extendedDetail }))
    if (pending.length) {
        let timeout
        await Promise.race([
            Promise.allSettled(pending),
            new Promise(resolve => {
                timeout = setTimeout(resolve, LOAD_EVENT_WAIT_TIMEOUT_MS)
            }),
        ])
        clearTimeout(timeout)
    }
}

const dispatchExtendablePrepareRelocateEvent = (target, detail, controller) => {
    const pending = []
    let accepting = true
    const extendedDetail = {
        ...detail,
        signal: controller.signal,
        waitUntil: task => {
            if (accepting && task?.then) pending.push(Promise.resolve(task))
        },
    }
    target.dispatchEvent(new CustomEvent('prepare-relocate', {
        detail: extendedDetail,
    }))
    accepting = false
    if (!pending.length) return

    let readyResolve
    let abortedResolve
    let readyDone = false
    let timeout
    const ready = new Promise(resolve => { readyResolve = resolve })
    const aborted = new Promise(resolve => { abortedResolve = resolve })
    const all = Promise.all(pending)
    const settled = Promise.race([
        all.then(() => true, () => false),
        aborted,
    ])
    const onAbort = () => {
        if (!readyDone) {
            readyDone = true
            clearTimeout(timeout)
            readyResolve(false)
        }
        abortedResolve(false)
        controller.signal.removeEventListener('abort', onAbort)
    }
    const resolveReady = (value, keepAbortListener = false) => {
        if (readyDone) return
        readyDone = true
        clearTimeout(timeout)
        if (!keepAbortListener)
            controller.signal.removeEventListener('abort', onAbort)
        readyResolve(value)
    }
    timeout = setTimeout(() => resolveReady(
        false, true), PREPARE_RELOCATE_WAIT_TIMEOUT_MS)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    void all.then(
        () => {
            controller.signal.removeEventListener('abort', onAbort)
            resolveReady(true)
        },
        () => {
            controller.abort()
            resolveReady(false)
        },
    )
    return { ready, settled }
}

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const MAX_ANIMATED_PAGE_SPAN = 32

const canAnimateScroll = (element, scrollProp) => {
    const horizontal = scrollProp === 'scrollLeft'
    const viewportSize = horizontal ? element.clientWidth : element.clientHeight
    if (!viewportSize) return false
    return [...element.children].every(child => {
        const contentSize = horizontal ? child.offsetWidth : child.offsetHeight
        return contentSize <= viewportSize * MAX_ANIMATED_PAGE_SPAN
    })
}

// Transforms ALL children of the container so multi-view layouts
// animate as a unified whole. Extra elements (e.g. background) are
// also transformed so they slide in sync with the content.
const animateScroll = (element, scrollProp, startValue, endValue, duration,
    extraElements = [], signal) => new Promise(resolve => {
    if (signal?.aborted) return resolve(false)
    if (document.hidden) {
        element[scrollProp] = endValue
        return resolve(true)
    }

    const children = [...element.children]
    if (!children.length) {
        element[scrollProp] = endValue
        return resolve(true)
    }

    const allElements = [...children, ...extraElements]
    const isHorizontal = scrollProp === 'scrollLeft'
    const delta = endValue - startValue
    const transformProp = isHorizontal ? 'translateX' : 'translateY'

    // Prepare all elements for animation
    for (const el of allElements) {
        el.style.willChange = 'transform'
        el.style.transform = `${transformProp}(0px)`
        el.style.transition = 'none'
    }

    // Force reflow to apply initial state
    element.getBoundingClientRect()

    // Start animation on all elements
    for (const el of allElements) {
        el.style.transition = `transform ${duration}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`
        el.style.transform = `${transformProp}(${-delta}px)`
    }

    const first = children[0]
    let resolved = false
    let timeout
    const cleanup = commit => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)
        first.removeEventListener('transitionend', onTransitionEnd)
        signal?.removeEventListener('abort', onAbort)

        for (const el of allElements) {
            el.style.willChange = ''
            el.style.transform = ''
            el.style.transition = ''
        }

        const committed = commit && !signal?.aborted
        if (committed) element[scrollProp] = endValue
        resolve(committed)
    }

    // Listen for transition end on the first child
    const onTransitionEnd = (e) => {
        if (e.target === first && e.propertyName === 'transform') {
            cleanup(true)
        }
    }
    const onAbort = () => cleanup(false)
    first.addEventListener('transitionend', onTransitionEnd)
    signal?.addEventListener('abort', onAbort, { once: true })

    // Fallback timeout in case transitionend doesn't fire
    timeout = setTimeout(() => cleanup(true), duration + 50)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRangeFromPoints = (doc, start, end, mapRect, pointAt) => {
    if (typeof doc.caretRangeFromPoint !== 'function' || !pointAt) return
    const width = Math.max(1, end - start)
    const height = Math.max(
        1,
        doc.documentElement?.clientHeight ?? 0,
        doc.defaultView?.innerHeight ?? 0,
    )
    const inlineOffsets = [0.01, 0.5, 0.99]
    const blockOffsets = [0.01, 0.08, 0.2, 0.4, 0.6, 0.8, 0.92, 0.99]
    const candidates = []

    for (const blockOffset of blockOffsets) {
        for (const inlineOffset of inlineOffsets) {
            const { x, y } = pointAt(
                start + width * inlineOffset,
                height * blockOffset,
            )
            let caret
            try {
                caret = doc.caretRangeFromPoint(x, y)
            } catch {
                continue
            }
            if (!caret?.startContainer || !doc.body?.contains(caret.startContainer)) continue
            const element = caret.startContainer.nodeType === Node.ELEMENT_NODE
                ? caret.startContainer
                : caret.startContainer.parentElement
            if (!element || element.closest('script, style')) continue
            try {
                const { left, right } = mapRect(element.getBoundingClientRect())
                if (left === 0 && right === 0) continue
                if (right < start || left > end) continue
            } catch {
                continue
            }
            candidates.push(caret)
        }
    }

    if (candidates.length < 2) return
    candidates.sort((a, b) =>
        a.compareBoundaryPoints(Range.START_TO_START, b))
    const first = candidates[0]
    const last = candidates[candidates.length - 1]
    if (first.compareBoundaryPoints(Range.START_TO_START, last) === 0) return
    const range = doc.createRange()
    try {
        range.setStart(first.startContainer, first.startOffset)
        range.setEnd(last.startContainer, last.startOffset)
    } catch {
        return
    }
    return range.collapsed ? undefined : range
}

const getVisibleRange = (doc, start, end, mapRect, pointAt = mapRect.pointAt) => {
    // A paginated chapter can contain hundreds of columns in one iframe.
    // Chromium's caret hit-testing uses its layout index, while walking every
    // node and reading every rect forces a full main-thread layout on each turn.
    const pointRange = getVisibleRangeFromPoints(doc, start, end, mapRect, pointAt)
    if (pointRange) return pointRange

    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            if (left === 0 && right === 0) return FILTER_REJECT
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (left === 0 && right === 0) return FILTER_REJECT
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const snapshotPreparedContents = contents => contents.map(content => {
    try {
        return { ...content, text: content.range.toString() }
    } catch {
        return { ...content, text: null }
    }
})

const isPreparedRangeCurrent = ({ doc, range, text }) => {
    if (text == null || range.collapsed) return false
    const { startContainer, endContainer } = range
    const isCurrentNode = node => node === doc
        || (node.ownerDocument === doc && doc.documentElement?.contains(node))
    if (!isCurrentNode(startContainer) || !isCurrentNode(endContainer)) return false
    try {
        return range.toString() === text
    } catch {
        return false
    }
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument?.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

// Whether a view's bounding rect overlaps the visible region of its container.
// Used by #syncA11y to mark only the pre-loaded views that lie outside the
// viewport as `aria-hidden`. Views still visible to sighted users (e.g. the
// right column in a dual-page spread that belongs to a different section
// than the left column) stay exposed to assistive tech.
// See readia/readia#4243 and readia/readia#4259.
export const isViewVisibleInContainer = (viewRect, containerRect) =>
    viewRect.right > containerRect.left
    && viewRect.left < containerRect.right
    && viewRect.bottom > containerRect.top
    && viewRect.top < containerRect.bottom

export const getDirection = doc => {
    const { defaultView } = doc
    let { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    // Some EPUBs set writing-mode on the first child of body instead of body itself
    if (!writingMode || writingMode === 'horizontal-tb') {
        const firstChild = doc.body.querySelector(':scope > :not([cfi-inert])')
        if (firstChild) {
            const childStyle = defaultView.getComputedStyle(firstChild)
            if (childStyle.writingMode === 'vertical-rl'
                || childStyle.writingMode === 'vertical-lr') {
                writingMode = childStyle.writingMode
            }
        }
    }
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStyles = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v)
}

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

const layoutsEqual = (a, b) => {
    if (a === b) return true
    if (!a || !b) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length
        && keys.every(key => a[key] === b[key])
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #columnCount = 1
    #layout = {}
    #contentPages = 0
    #bgImageSize = null
    #loadGeneration = 0
    #cancelPendingLoad = null
    ready = true
    fontReady = Promise.resolve()
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'flex-start',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    get contentPages() {
        return this.#contentPages
    }
    markPending() {
        this.ready = false
        Object.assign(this.#element.style, {
            position: 'absolute',
            inset: '0',
            visibility: 'hidden',
            pointerEvents: 'none',
        })
    }
    markReady({ expand = true } = {}) {
        if (this.ready) return
        this.ready = true
        Object.assign(this.#element.style, {
            position: 'relative',
            inset: '',
            visibility: '',
            pointerEvents: '',
        })
        if (expand) this.expand()
    }
    async load(src, data, afterLoad, beforeRender, afterRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        const loadGeneration = ++this.#loadGeneration
        return new Promise((resolve, reject) => {
            let settled = false
            let timeout
            const finish = (committed, error) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                this.#iframe.removeEventListener('load', onLoad)
                if (this.#cancelPendingLoad === cancel) this.#cancelPendingLoad = null
                if (error) reject(error)
                else resolve(committed)
            }
            const cancel = () => {
                if (loadGeneration === this.#loadGeneration) this.#loadGeneration++
                finish(false)
            }
            const onLoad = async () => {
                try {
                    const doc = this.document
                    await afterLoad?.(doc)
                    if (loadGeneration !== this.#loadGeneration) return finish(false)

                    this.#iframe.setAttribute('aria-label', doc.title)
                    // it needs to be visible for Firefox to get computed style
                    this.#iframe.style.display = 'block'
                    const { vertical, rtl } = getDirection(doc)
                    this.docBackground = getBackground(doc)
                    doc.body.style.background = 'none'
                    // Preload background image to get natural dimensions;
                    // in scrolled mode the view expands to fit the image.
                    const bgUrl = this.docBackground
                        ?.match(/url\(["']?([^"')]+)["']?\)/)?.[1]
                    if (bgUrl && !this.container.noBackground) {
                        const img = new Image()
                        img.onload = () => {
                            if (loadGeneration !== this.#loadGeneration) return
                            this.#bgImageSize = {
                                width: img.naturalWidth,
                                height: img.naturalHeight,
                            }
                            if (!this.#column) this.expand()
                        }
                        img.src = bgUrl
                    }
                    this.#iframe.style.display = 'none'

                    this.#vertical = vertical
                    this.#rtl = rtl

                    this.#contentRange.selectNodeContents(doc.body)
                    let layout
                    try {
                        layout = beforeRender?.({ vertical, rtl })
                        this.#iframe.style.display = 'block'
                        this.render(layout)
                    } finally {
                        afterRender?.()
                    }
                    this.#observer.observe(doc.body)

                    // the resize observer above doesn't work in Firefox
                    // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                    // until the bug is fixed we can at least account for font load
                    this.fontReady = doc.fonts.ready.then(() => {
                        if (loadGeneration === this.#loadGeneration) this.expand()
                    })

                    finish(true)
                } catch (error) {
                    if (loadGeneration !== this.#loadGeneration) finish(false)
                    else finish(false, error)
                }
            }
            this.#cancelPendingLoad?.()
            this.#cancelPendingLoad = cancel
            this.#iframe.addEventListener('load', onLoad, { once: true })
            timeout = setTimeout(() => {
                if (loadGeneration === this.#loadGeneration) this.#loadGeneration++
                finish(false, new Error(
                    `Iframe load timed out after ${IFRAME_LOAD_TIMEOUT_MS}ms`))
            }, IFRAME_LOAD_TIMEOUT_MS)
            try {
                if (data) {
                    this.#iframe.srcdoc = data
                } else {
                    this.#iframe.src = src
                }
            } catch (error) {
                finish(false, error)
            }
        })
    }
    render(layout) {
        if (!layout || !this.document?.documentElement) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ width, height, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        const availableWidth = Math.trunc(width - marginLeft - marginRight)
        const availableHeight = Math.trunc(height - marginTop - marginBottom)
        const sidePaddingLeft = marginLeft / 2 + gap / 2
        const sidePaddingRight = marginRight / 2 + gap / 2
        setStyles(doc.documentElement, {
            'padding': vertical
                ? `${marginTop * 1.5}px 0px ${marginBottom * 1.5}px 0px`
                : `0px ${sidePaddingRight}px 0px ${sidePaddingLeft}px`,
            '--page-margin-top': `${vertical ? marginTop * 1.5 : marginTop}px`,
            '--page-margin-right': `${vertical ? marginRight : sidePaddingRight}px`,
            '--page-margin-bottom': `${vertical ? marginBottom * 1.5 : marginBottom}px`,
            '--page-margin-left': `${vertical ? marginLeft : sidePaddingLeft}px`,
            '--full-width': `${Math.trunc(width)}`,
            '--full-height': `${Math.trunc(height)}`,
            '--available-width': `${availableWidth}`,
            '--available-height': `${availableHeight}`,
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
            // Prevent position:absolute/fixed on body from coupling its
            // size to the iframe, which causes diverging expand() loops
            'position': 'static',
        })
        this.setImageSize(availableWidth, availableHeight)
        this.expand()
    }
    columnize({ width, height, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth, columnCount }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width
        this.#columnCount = columnCount || 1

        const doc = this.document
        const horizontalColumnGap = columnCount > 1 ? (marginLeft + marginRight) / 4 + gap / 2 : (marginLeft + marginRight) / 2 + gap
        const sidePaddingLeft = columnCount > 1 ? marginLeft / 4 + gap / 4 : marginLeft / 2 + gap / 2
        const sidePaddingRight = columnCount > 1 ? marginRight / 4 + gap / 4 : marginRight / 2 + gap / 2
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': vertical ? `${(marginTop + marginBottom) * 1.5}px` : `${horizontalColumnGap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        const availableWidth = vertical
            ? Math.trunc(width - marginLeft / 2 - marginRight / 2 - gap)
            : Math.trunc(width / this.#columnCount)
        const availableHeight = vertical
            ? Math.trunc(height / this.#columnCount)
            : Math.trunc(height - marginTop - marginBottom)
        setStyles(doc.documentElement, {
            'padding': vertical
                ? `${marginTop * 1.5}px ${marginRight}px ${marginBottom * 1.5}px ${marginLeft}px`
                : `${marginTop}px ${sidePaddingRight}px ${marginBottom}px ${sidePaddingLeft}px`,
            '--page-margin-top': `${vertical ? marginTop * 1.5 : marginTop}px`,
            '--page-margin-right': `${vertical ? marginRight : sidePaddingRight}px`,
            '--page-margin-bottom': `${vertical ? marginBottom * 1.5 : marginBottom}px`,
            '--page-margin-left': `${vertical ? marginLeft : sidePaddingLeft}px`,
            '--full-width': `${Math.trunc(availableWidth)}`,
            '--full-height': `${Math.trunc(availableHeight)}`,
            '--available-width': `${availableWidth}`,
            '--available-height': `${availableHeight}`,
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
            // Prevent position:absolute/fixed on body from coupling its
            // size to the iframe, which causes diverging expand() loops
            'position': 'static',
        })
        this.setImageSize(availableWidth, availableHeight)
        this.expand()
    }
    setImageSize(availableWidth, availableHeight) {
        const { width, height, marginTop, marginRight, marginBottom, marginLeft } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        const pageFullscreen = doc.documentElement.hasAttribute('data-duokan-page-fullscreen')
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // clear previous inline constraints so we read CSS-authored values,
            // not stale pixel values from a previous resize (#3634)
            el.style.removeProperty('max-width')
            el.style.removeProperty('max-height')
            // preserve max size if they are already set in CSS
            let { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            if (parseInt(maxWidth) > availableWidth) {
                maxWidth = `${availableWidth}px`
            }
            if (parseInt(maxHeight) > availableHeight) {
                maxHeight = `${availableHeight}px`
            }
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - (pageFullscreen ? 0 : (marginTop + marginBottom))}px`,
                'max-width': vertical
                    ? `${width - (pageFullscreen ? 0 : (marginLeft + marginRight))}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
            if (pageFullscreen) {
                setStylesImportant(doc.documentElement, {
                    position: 'relative',
                })
                setStylesImportant(el, {
                    position: 'absolute',
                    inset: '0',
                    width: '100%',
                    height: '100%',
                    margin: '0',
                })
                let ancestor = el.parentElement
                while (ancestor && ancestor !== doc.body) {
                    setStylesImportant(ancestor, {
                        width: '100%',
                        height: '100%',
                        margin: '0',
                        padding: '0',
                    })
                    ancestor = ancestor.parentElement
                }
                if (el.localName === 'svg') {
                    el.setAttribute('preserveAspectRatio', 'xMidYMid meet')
                }
            }
        }
    }
    get #zoom() {
        // Safari does not zoom the client rects, while Chrome, Edge and Firefox does
        if (/^((?!chrome|android).)*AppleWebKit/i.test(navigator.userAgent) && !window.chrome) {
            return window.getComputedStyle(this.document.body).zoom || 1.0
        }
        return 1.0
    }
    expand() {
        if (!this.document?.documentElement) return
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = (contentStart + contentRect[side]) * this.#zoom
            // Size content by individual columns, not full spreads.
            // This allows adjacent sections to share a spread when a
            // section doesn't fill all available columns.
            const columnSize = this.#size / this.#columnCount
            // A layout pass can run while the host is still zero-sized (for
            // example a concealed reader or a section swap). Writing NaN/0
            // widths here drops the column box and leaves the chapter as one
            // full-width overflowing column until something forces a reflow.
            if (!Number.isFinite(columnSize) || columnSize <= 0) return
            const pageCount = Math.ceil(contentSize / columnSize)
            this.#contentPages = pageCount
            const expandedSize = pageCount * columnSize
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            // One column per "page" — overflow columns extend into adjacent pages
            documentElement.style[side] = `${columnSize}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            let expandedSize = contentSize
            // If the section has a background image, ensure the view is
            // at least as large as the image scaled to fit the cross axis
            if (this.#bgImageSize) {
                const crossSize = this.#element.getBoundingClientRect()[otherSide]
                if (crossSize > 0) {
                    const { width: imgW, height: imgH } = this.#bgImageSize
                    const scaledSize = this.#vertical
                        ? imgW * crossSize / imgH
                        : imgH * crossSize / imgW
                    expandedSize = Math.max(expandedSize, scaledSize)
                }
            }
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    #loupeEl = null
    #loupeScaler = null
    #loupeCursor = null
    // Show a magnifier loupe inside the iframe document.
    // winX/winY are in main-window (screen) coordinates.
    showLoupe(winX, winY, { isVertical, color, gap, margin, radius, magnification }) {
        const doc = this.document
        if (!doc) return

        const frameRect = this.#iframe.getBoundingClientRect()
        // Cursor in iframe-viewport coordinates.
        const vpX = winX - frameRect.left
        const vpY = winY - frameRect.top

        // Cursor in document coordinates (accounts for scroll).
        const scrollX = doc.scrollingElement?.scrollLeft ?? 0
        const scrollY = doc.scrollingElement?.scrollTop ?? 0
        const docX = vpX + scrollX
        const docY = vpY + scrollY

        const MAGNIFICATION = magnification
        const MARGIN = margin

        // Capsule dimensions: elongated along the reading direction.
        // For horizontal text the capsule is wider; for vertical it is taller.
        const shortSide = radius * 2
        const longSide  = Math.round(radius * 3.6)
        const loupeW = isVertical ? shortSide : longSide
        const loupeH = isVertical ? longSide  : shortSide
        const halfW = loupeW / 2
        const halfH = loupeH / 2
        const borderRadius = shortSide / 2  // fully rounded ends

        // Position loupe above the cursor (or to the left for vertical text).
        const GAP = gap
        let loupeLeft = isVertical ? vpX - loupeW - GAP : vpX - halfW
        let loupeTop  = isVertical ? vpY - halfH        : vpY - loupeH - GAP
        loupeLeft = Math.max(MARGIN, Math.min(loupeLeft, frameRect.width  - loupeW - MARGIN))
        loupeTop  = Math.max(MARGIN, Math.min(loupeTop,  frameRect.height - loupeH - MARGIN))

        // CSS-transform math: map document point (docX, docY) to loupe centre.
        //   visual_pos = offset + coord × MAGNIFICATION = halfW (or halfH)
        //   ⟹ offset = half − coord × MAGNIFICATION
        const offsetX = halfW - docX * MAGNIFICATION
        const offsetY = halfH - docY * MAGNIFICATION

        // Build loupe DOM structure once; cache it across hide/show cycles so
        // the expensive body clone is not repeated on every drag start.
        if (!this.#loupeEl || !this.#loupeEl.isConnected) {
            this.#loupeEl = doc.createElement('div')

            // Clone the live body once — inside the iframe the epub's CSS
            // variables, @font-face fonts, and styles apply automatically.
            const bodyClone = doc.body.cloneNode(true)

            // Wrap the clone in a div that replicates documentElement's inline
            // styles (column-width, column-gap, padding, height, etc.) so text
            // flows with the same column layout as the original document.
            const htmlWrapper = doc.createElement('div')
            htmlWrapper.style.cssText = doc.documentElement.style.cssText
            // expand() constrains documentElement's page-axis dimension to one
            // page size (width for horizontal, height for vertical).  Override
            // with the full scroll dimension so all columns are rendered.
            if (this.#vertical)
                htmlWrapper.style.height = `${doc.documentElement.scrollHeight}px`
            else
                htmlWrapper.style.width = `${doc.documentElement.scrollWidth}px`
            htmlWrapper.appendChild(bodyClone)

            this.#loupeScaler = doc.createElement('div')
            this.#loupeScaler.appendChild(htmlWrapper)

            const cursorLen = Math.round(shortSide * 0.44)
            this.#loupeCursor = doc.createElement('div')
            this.#loupeCursor.style.cssText = isVertical
                ? `position:absolute;left:calc(50% - ${cursorLen / 2}px);top:50%;`
                + `margin-top:-1px;width:${cursorLen}px;height:2px;background:${color};pointer-events:none;z-index:1;box-sizing:border-box;`
                : `position:absolute;left:50%;top:calc(50% - ${cursorLen / 2}px);`
                + `margin-left:-1px;width:2px;height:${cursorLen}px;background:${color};pointer-events:none;z-index:1;box-sizing:border-box;`

            this.#loupeEl.appendChild(this.#loupeScaler)
            this.#loupeEl.appendChild(this.#loupeCursor)
            doc.documentElement.appendChild(this.#loupeEl)

            // Static loupe shell styles (set once).
            this.#loupeEl.style.cssText = `
                position: absolute;
                width: ${loupeW}px;
                height: ${loupeH}px;
                border-radius: ${borderRadius}px;
                overflow: hidden;
                border: 2.5px solid ${color};
                box-shadow: 0 6px 24px rgba(0,0,0,0.28);
                background-color: var(--theme-bg-color);
                z-index: 9999;
                pointer-events: none;
                user-select: none;
                box-sizing: border-box;
                contain: strict;
            `

            // Static scaler styles (set once; only left/top change per move).
            this.#loupeScaler.style.cssText = `
                position: absolute;
                transform: scale(${MAGNIFICATION});
                transform-origin: 0 0;
                pointer-events: none;
            `
        }

        // Ensure visible (hideLoupe hides via CSS instead of removing).
        this.#loupeEl.style.display = ''

        // Update only the dynamic position values (fast path on every move).
        this.#loupeScaler.style.left = `${offsetX}px`
        this.#loupeScaler.style.top = `${offsetY}px`
        this.#loupeScaler.style.width = `${doc.documentElement.scrollWidth}px`
        this.#loupeScaler.style.height = `${doc.documentElement.scrollHeight}px`
        this.#loupeEl.style.left = `${loupeLeft + scrollX}px`
        this.#loupeEl.style.top = `${loupeTop + scrollY}px`

        // Cut a capsule-shaped hole in the overlayer so highlights don't paint
        // over the loupe.
        if (this.#overlayer) {
            const overlayerRect = this.#overlayer.element.getBoundingClientRect()
            const dx = frameRect.left - overlayerRect.left
            const dy = frameRect.top - overlayerRect.top

            const pad = 3
            const cx = loupeLeft + halfW + dx
            const cy = loupeTop + halfH + dy

            this.#overlayer.setHole(cx, cy, loupeW + pad * 2, loupeH + pad * 2, borderRadius + pad)
        }
    }
    hideLoupe() {
        // Hide via CSS instead of removing — keeps the cached body clone so
        // the next showLoupe call skips the expensive cloneNode(true).
        if (this.#loupeEl) {
            this.#loupeEl.style.display = 'none'
        }
        if (this.#overlayer)
            this.#overlayer.clearHole()
    }
    destroyLoupe() {
        if (this.#loupeEl) {
            this.#loupeEl.remove()
            this.#loupeEl = null
            this.#loupeScaler = null
            this.#loupeCursor = null
        }
        if (this.#overlayer)
            this.#overlayer.clearHole()
    }
    destroy() {
        this.#cancelPendingLoad?.()
        this.#cancelPendingLoad = null
        this.#loadGeneration++
        if (this.document?.body) this.#observer.unobserve(this.document.body)
        this.destroyLoupe()
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'max-inline-size', 'max-block-size', 'max-column-count',
        'no-preload', 'no-background', 'no-continuous-scroll',
    ]
    #root = this.attachShadow({ mode: 'open' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #views = new Map() // Map<sectionIndex, View>
    #primaryIndex = -1
    #vertical = false
    #rtl = false
    #marginTop = 0
    #marginBottom = 0
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    #scrollLocked = false
    #isAnimating = false
    #filling = false // true while #fillVisibleArea is running
    #fillPromise = null // tracks in-progress #fillVisibleArea for awaiting
    #sectionLoadPromises = new Map() // section index -> in-progress adjacent load
    #lifecycleGeneration = 0
    #relocationGeneration = 0
    #prepareRelocateController = null
    #preparingRelocation = false
    #scrollAnimationController = null
    #scrollAnimationGeneration = 0
    #navigationGeneration = 0
    #goToRequestGeneration = 0
    #latestValidGoToRequest = 0
    #directNavigationPromises = new Map()
    #disposed = false
    #stabilizing = false // true while #display is stabilizing layout
    #rendered = false // true after first #display completes
    #lastLayout = null // cached layout from the last #beforeRender call
    // Cache of section index → vertical (boolean). Populated as views
    // are loaded so we can check direction *before* loading a section.
    #directionCache = new Map()
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin-top: 48px;
            --_margin-right: 48px;
            --_margin-bottom: 48px;
            --_margin-left: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: var(--_max-column-count);
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_half-margin-left: calc(var(--_margin-left) / 2);
            --_half-margin-right: calc(var(--_margin-right) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            --_column-count: 1;
            --_outer-min-left: calc((var(--_column-count) - 1) * (var(--_margin-left) / 4 + var(--_gap) / 4));
            --_outer-min-right: calc((var(--_column-count) - 1) * (var(--_margin-right) / 4 + var(--_gap) / 4));
            display: grid;
            grid-template-columns:
                minmax(var(--_outer-min-left), 1fr)
                var(--_margin-left)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_margin-right)
                minmax(var(--_outer-min-right), 1fr);
            grid-template-rows:
                minmax(var(--_margin-top), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin-bottom), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 1 / -1;
            overflow: hidden;
            display: flex;
            flex-direction: row;
            transition: opacity 50ms ease-in;
        }
        #container.vertical {
            flex-direction: column;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 2 / 5;
            grid-row: 1 / -1;
            overflow: auto;
            overflow-anchor: auto;
            flex-direction: column;
        }
        :host([flow="scrolled"]) #container.vertical {
            flex-direction: row;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header {
            display: grid;
            height: var(--_margin-top);
        }
        #footer {
            display: grid;
            height: var(--_margin-bottom);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container" part="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        const debouncedScroll = debounce(() => {
            if (this.scrolled && !this.#isAnimating) {
                // Skip entirely while stabilizing — preserve #justAnchored
                // so the first post-stabilization fire still sees it.
                if (this.#stabilizing) return
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
                // Load previous section when user scrolls near the top.
                // Done in debounced handler (not instant) to avoid cascade
                // from rapid DOM insertions breaking scroll anchoring.
                if (!this.noPreload && !this.noContinuousScroll && !this.#filling && this.#renderedStart < this.size) {
                    const sorted = this.#sortedViews
                    const firstIndex = sorted[0]?.[0]
                    if (firstIndex != null) {
                        const prevIdx = this.#adjacentIndex(-1, firstIndex)
                        if (prevIdx != null && !this.#views.has(prevIdx) && this.#isSameDirection(prevIdx)) {
                            this.#filling = true
                            this.#loadAdjacentSection(prevIdx)
                                .finally(() => {
                                    this.#filling = false
                                    this.dispatchEvent(new Event('stabilized'))
                                })
                        }
                    }
                }
            } else if (!this.scrolled) {
              this.#afterScroll('container-scroll')
            }
        }, 250)
        this.#container.addEventListener('scroll', () => {
            if (!this.#isAnimating) this.dispatchEvent(new Event('scroll'))
            // Preload forward when fewer than minPages ahead
            if (!this.noPreload && !this.noContinuousScroll && !this.#filling && !this.#stabilizing) {
                const minPages = 5
                const pagesAhead = this.size > 0
                    ? Math.floor((this.#renderedViewSize - this.#renderedEnd) / this.size)
                    : 0
                if (pagesAhead < minPages) {
                    const sorted = this.#sortedViews
                    const lastIndex = sorted[sorted.length - 1]?.[0]
                    if (lastIndex != null) {
                        const nextIdx = this.#adjacentIndex(1, lastIndex)
                        if (nextIdx != null && !this.#views.has(nextIdx) && this.#isSameDirection(nextIdx)) {
                            this.#filling = true
                            this.#loadAdjacentSection(nextIdx)
                                .finally(() => {
                                    this.#filling = false
                                    this.dispatchEvent(new Event('stabilized'))
                                })
                        }
                    }
                }
            }
            debouncedScroll()
        })

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                // FIXME: this won't work on Android WebView, disable for now
                if (!isPointerSelecting && isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => {
                if (this.scrolled) return null
                if (this.#container && this.#container.contains(e.target)) {
                    // NOTE: `requestAnimationFrame` is needed in WebKit
                    requestAnimationFrame(() => this.#scrollToAnchor(e.target))
                }
            })
        })

        this.#mediaQueryListener = () => {
            const view = this.#primaryView
            if (!view) return
            this.#replaceBackground()
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    get #primaryView() {
        return this.#views.get(this.#primaryIndex)
    }
    get #sortedViews() {
        return [...this.#views.entries()]
            .filter(([, view]) => view.ready)
            .sort(([a], [b]) => a - b)
    }
    get primaryIndex() {
        return this.#primaryIndex
    }
    setAttribute(name, value) {
        // The scrolled-mode scroll handler is debounced, so #anchor and
        // #primaryIndex can lag behind the user's actual viewport by up to
        // ~250ms. Toggling out of scrolled mode within that window made
        // render() restore the stale anchor — reverting the position to a
        // previously visible section. Flush the pending scroll state here,
        // before the attribute change so the layout is still in scrolled
        // mode and `this.scrolled` (which reads the attribute) is still true.
        if (name === 'flow'
            && this.scrolled
            && String(value) !== 'scrolled'
            && this.#views.size > 0) {
            this.#flushScrolledState()
        }
        super.setAttribute(name, value)
    }
    #flushScrolledState() {
        if (this.#views.size > 1) this.#detectPrimaryView()
        const result = this.#getVisibleRange()
        if (result?.range && !result.range.collapsed) this.#anchor = result.range
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.#cancelPreparedRelocation()
                this.render()
                break
            case 'gap':
            case 'margin-top':
            case 'margin-bottom':
            case 'margin-left':
            case 'margin-right':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'no-continuous-scroll':
                if (this.noContinuousScroll) {
                    for (const [i] of this.#views) {
                        if (i !== this.#primaryIndex) this.#destroyView(i)
                    }
                }
                break
        }
    }
    open(book) {
        this.#cancelPreparedRelocation()
        this.#disposed = false
        this.#lifecycleGeneration++
        this.#navigationGeneration++
        this.#sectionLoadPromises.clear()
        this.#directNavigationPromises.clear()
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/([{\s;])-epub-/gi, '$1')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView(index, pending = false) {
        // Destroy existing view for this index if any
        const existing = this.#views.get(index)
        if (existing) {
            existing.destroy()
            this.#container.removeChild(existing.element)
            this.#views.delete(index)
        }
        const view = new View({
            container: this,
            onExpand: () => {
                // Only the primary view's resize should adjust scroll;
                // non-primary views (preloaded/adjacent) must not scroll
                if (this.#filling || this.#stabilizing
                    || this.#preparingRelocation || this.scrolled) return
                if (this.#primaryIndex === index)
                    this.#scrollToAnchor(this.#anchor)
            },
        })
        if (pending) view.markPending()
        this.#views.set(index, view)
        const sorted = [...this.#views.entries()].sort(([a], [b]) => a - b)
        const myPos = sorted.findIndex(([i]) => i === index)
        const nextEntry = sorted[myPos + 1]
        if (nextEntry) this.#container.insertBefore(view.element, nextEntry[1].element)
        else this.#container.append(view.element)
        this.#syncA11y()
        return view
    }
    // Hide off-screen pre-loaded views from the accessibility tree so
    // screen-reader swipe-next does not wander into them (which would land
    // several pages into the next section instead of its first paragraph).
    //
    // Only `aria-hidden` is used — `inert` would also block pointer events
    // and text selection, which breaks visible non-primary views such as
    // the right column of a dual-page spread when each column belongs to
    // a different section (readia/readia#4243, readia/readia#4259).
    //
    // Visible non-primary views stay exposed to assistive tech because a
    // sighted user can read them on the same spread.
    #syncA11y() {
        const containerRect = this.#container.getBoundingClientRect()
        for (const [index, view] of this.#views) {
            if (!view.ready) {
                view.element.setAttribute('aria-hidden', 'true')
                continue
            }
            const isPrimary = index === this.#primaryIndex
            const isVisible = isPrimary
                || isViewVisibleInContainer(
                    view.element.getBoundingClientRect(), containerRect)
            if (isVisible) view.element.removeAttribute('aria-hidden')
            else view.element.setAttribute('aria-hidden', 'true')
        }
    }
    #destroyView(index) {
        const view = this.#views.get(index)
        if (!view) return
        view.destroy()
        this.#container.removeChild(view.element)
        this.#views.delete(index)
        this.sections[index]?.unload?.()
    }
    #destroyAllViews() {
        for (const [index] of this.#views) this.#destroyView(index)
    }
    #clearViewsExcept(keepIndices) {
        for (const [index] of this.#views) {
            if (!keepIndices.has(index)) this.#destroyView(index)
        }
    }
    // Check if a section has the same writing direction as current primary.
    // Returns true if same or unknown (not yet cached).
    #isSameDirection(index) {
        if (!this.#directionCache.has(index)) return true
        return this.#directionCache.get(index) === this.#vertical
    }
    // Update the #background grid so each column shows the correct section's
    // background. Pass atPosition to pre-compute for a destination scroll
    // position (e.g. before an animation starts).
    #replaceBackground(atPosition) {
        const doc = this.#primaryView?.document
        if (!doc?.documentElement) return
        if (this.noBackground) return
        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)
        const themeBgColor = htmlStyle.getPropertyValue('--theme-bg-color')
        const overrideColor = htmlStyle.getPropertyValue('--override-color') === 'true'
        const bgTextureId = htmlStyle.getPropertyValue('--bg-texture-id')
        const isDarkMode = htmlStyle.getPropertyValue('color-scheme') === 'dark'
        const fallbackBg = themeBgColor || ''

        const resolveBackground = (background) => {
            if (!background) return fallbackBg
            if (themeBgColor) {
                const parsed = background.split(/\s(?=(?:url|rgb|hsl|#[0-9a-fA-F]{3,6}))/)
                if ((isDarkMode || overrideColor) && (bgTextureId === 'none' || !bgTextureId)) {
                    parsed[0] = themeBgColor
                }
                return parsed.join(' ')
            }
            return background
        }

        // Reset any inline backgrounds left over from a previous mode so the
        // host's texture isn't occluded after toggling.
        this.#background.style.background = ''
        for (const [, view] of this.#sortedViews) {
            view.element.style.background = ''
        }

        if (this.scrolled) {
            // In scrolled mode, set background directly on each view element
            // so it scrolls with the content. The static #background provides
            // the fallback color for margins and gaps between views.
            const hasTexture = !!bgTextureId && bgTextureId !== 'none'
            this.#background.innerHTML = ''
            this.#background.style.display = ''
            this.#background.style.background = hasTexture ? '' : fallbackBg
            for (const [, view] of this.#sortedViews) {
                const resolved = resolveBackground(view.docBackground)
                const isTransparent = !resolved
                    || /^\s*(transparent|rgba\(0,\s*0,\s*0,\s*0\))/.test(resolved)
                view.element.style.background = hasTexture && isTransparent ? '' : resolved
            }
            return
        }

        const cc = this.columnCount
        const columnSize = this.size / cc
        const sorted = this.#sortedViews

        this.#background.innerHTML = ''
        this.#background.style.display = 'grid'
        this.#background.style.gridTemplateColumns = `repeat(${cc}, 1fr)`

        const scrollPos = atPosition ?? this.#renderedStart
        for (let i = 0; i < cc; i++) {
            const columnMid = Math.abs(scrollPos) + (i + 0.5) * columnSize
            let bg = fallbackBg

            // Find which view's content area contains this column
            let offset = 0
            for (const [, view] of sorted) {
                const viewSize = view.element.getBoundingClientRect()[this.sideProp]
                if (columnMid < offset + viewSize) {
                    const contentStart = offset
                    const contentEnd = contentStart + view.contentPages * columnSize
                    if (columnMid >= contentStart && columnMid < contentEnd) {
                        bg = resolveBackground(view.docBackground)
                    }
                    break
                }
                offset += viewSize
            }

            const col = document.createElement('div')
            col.style.background = bg
            col.style.backgroundAttachment = 'initial'
            col.style.width = '100%'
            col.style.height = '100%'
            this.#background.appendChild(col)
        }
    }
    #beforeRender({ vertical, rtl }, { preserveViews = false } = {}) {
        // If writing-mode is about to change, destroy all non-primary
        // views BEFORE updating global state. This prevents stale views
        // with the wrong direction from remaining in the container while
        // flex-direction / scrollProp / sideProp flip.
        if (!preserveViews && this.#rendered && vertical !== this.#vertical) {
            for (const [i] of this.#views) {
                if (i !== this.#primaryIndex) this.#destroyView(i)
            }
        }
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)
        this.#container.classList.toggle('vertical', vertical)

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const marginTop = parseFloat(style.getPropertyValue('--_margin-top'))
        const marginRight = parseFloat(style.getPropertyValue('--_margin-right'))
        const marginBottom = parseFloat(style.getPropertyValue('--_margin-bottom'))
        const marginLeft = parseFloat(style.getPropertyValue('--_margin-left'))
        this.#marginTop = marginTop
        this.#marginBottom = marginBottom

        // Compute the column count from the host (Paginator) size rather than
        // the #container size. The container width depends on --_column-count
        // via the grid template (the outer 1fr tracks have a non-zero min for
        // multi-column spreads), so deriving the column count from container
        // size at threshold widths creates a feedback loop where the layout
        // oscillates between 1 and 2 columns on resize.
        const flow = this.getAttribute('flow')
        const hostRect = this.getBoundingClientRect()
        const hostSize = vertical ? hostRect.height : hostRect.width
        const divisor = flow === 'scrolled'
            ? 1
            : Math.min(
                maxColumnCount + (vertical ? 1 : 0),
                Math.ceil(Math.floor(hostSize) / Math.floor(maxInlineSize)),
            )
        // Set --_column-count BEFORE measuring the container so the read
        // below reflects the grid template that will actually be used.
        this.#top.style.setProperty('--_column-count', divisor)

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            this.columnCount = 1
            this.#replaceBackground()

            const layout = { width, height, flow, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth, columnCount: 1 }
            this.#lastLayout = layout
            return layout
        }

        const columnWidth = vertical
            ? (size / divisor - marginTop * 1.5 - marginBottom * 1.5)
            : (size / divisor - gap - marginRight / 2 - marginLeft / 2)
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.columnCount = divisor
        this.#replaceBackground()

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(Math.floor(width) / Math.floor(maxInlineSize)))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        const layout = { width, height, marginTop, marginRight, marginBottom, marginLeft, gap, columnWidth, columnCount: divisor }
        this.#lastLayout = layout
        return layout
    }
    render() {
        if (this.#views.size === 0) return
        const primaryView = this.#primaryView
        if (!primaryView) return
        this.#stabilizing = true
        const layout = this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        })
        for (const [, view] of this.#views) {
            if (view.document) view.render(layout)
        }
        // Scroll synchronously to prevent visible layout shift during resize.
        // RAF deferral is only needed for initial display and mode switches
        // (handled by #display), not for resize re-renders.
        this.#scrollToAnchor(this.#anchor)
        this.#stabilizing = false
        this.dispatchEvent(new Event('stabilized'))
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get noPreload() {
        return this.hasAttribute('no-preload')
    }
    get noBackground() {
        return this.hasAttribute('no-background')
    }
    get noContinuousScroll() {
        return this.scrolled && this.hasAttribute('no-continuous-scroll')
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        const primaryView = this.#primaryView
        if (!primaryView) return 0
        return primaryView.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return this.#renderedStart - this.#getViewOffset(this.#primaryIndex)
    }
    get end() {
        return this.#renderedEnd - this.#getViewOffset(this.#primaryIndex)
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        const primaryView = this.#primaryView
        if (!primaryView) return 0
        const viewSize = primaryView.element.getBoundingClientRect()[this.sideProp]
        return Math.round(viewSize / this.size)
    }
    get containerPosition() {
        return this.#container[this.scrollProp]
    }
    get isOverflowX() {
        return false
    }
    get isOverflowY() {
        return false
    }
    get #renderedViewSize() {
        if (this.#views.size === 0) return 0
        let total = 0
        for (const [, view] of this.#sortedViews)
            total += view.element.getBoundingClientRect()[this.sideProp]
        return total
    }
    get #renderedStart() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get #renderedEnd() {
        return this.#renderedStart + this.size
    }
    get #renderedPage() {
        return Math.floor(((this.#renderedStart + this.#renderedEnd) / 2) / this.size)
    }
    get #renderedPages() {
        return Math.round(this.#renderedViewSize / this.size)
    }
    set containerPosition(newVal) {
        this.#container[this.scrollProp] = newVal
    }
    set scrollLocked(value) {
        this.#scrollLocked = value
    }

    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        this.containerPosition = Math.max(min, Math.min(max,
            this.containerPosition + delta))
    }

    // vx, vy: velocity at the end of the swipe (pixels per ms)
    // dx, dy: total distance swiped
    // dt: total time of the swipe (ms)
    snap(vx, vy, dx, dy, dt) {
        if (this.#disposed) return
        const size = this.size
        if (!size) return
        const velocity = this.#vertical ? vy : vx
        const distance = this.#vertical ? dy : dx
        const crossDistance = this.#vertical ? dx : dy
        const averageVelocity = dt > 0 ? distance / dt : 0
        const [offset, a, b] = this.#scrollBounds
        const start = this.#renderedStart
        const end = this.#renderedEnd
        const pages = this.#renderedPages
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b

        // Decide from the whole gesture rather than the last touchmove's
        // velocity. That velocity is noisy (users routinely slow the finger
        // down before lifting), which made gentle swipes stay on the current
        // page and briefly leave two pages half-visible. Either a deliberate
        // drag past a small threshold or a flick now turns exactly one page.
        const alongAxis = Math.abs(distance) >= Math.abs(crossDistance)
        const dragged = Math.abs(distance) >= size * 0.06
        const flicked = (Number.isFinite(velocity) && Math.abs(velocity) >= 0.25)
            || (Number.isFinite(averageVelocity) && Math.abs(averageVelocity) >= 0.35)
        const direction = Math.sign(distance) || Math.sign(velocity)
        const turned = alongAxis && direction !== 0 && (dragged || flicked)
        const pageDelta = turned ? (direction > 0 ? 1 : -1) * (this.#rtl ? -1 : 1) : 0
        const basePage = Number.isFinite(this.#touchState?.page)
            ? this.#touchState.page
            : Math.floor(((start + end) / 2) / size)
        const minPage = Math.floor(min / size)
        const maxPage = Math.floor(max / size)
        const page = Math.max(minPage, Math.min(maxPage, basePage + pageDelta))
        const dir = page < 0 ? -1 : page >= pages ? 1 : null
        const doGoTo = () => {
            if (!dir) return
            const sorted = this.#sortedViews
            const edgeIndex = dir < 0
                ? sorted[0]?.[0] ?? this.#primaryIndex
                : sorted[sorted.length - 1]?.[0] ?? this.#primaryIndex
            const index = this.#adjacentIndex(dir, edgeIndex)
            if (index == null) return
            const lifecycleGeneration = this.#lifecycleGeneration
            this.#cancelPreparedRelocation()
            const navigationGeneration = ++this.#navigationGeneration
            const task = this.#goTo({
                index,
                anchor: dir < 0 ? () => 1 : () => 0,
                reason: 'snap',
            }, navigationGeneration, lifecycleGeneration)
            const directNavigation = { navigationGeneration, task, kind: 'snap' }
            this.#directNavigationPromises.set(index, directNavigation)
            return task.finally(() => {
                if (this.#directNavigationPromises.get(index) === directNavigation)
                    this.#directNavigationPromises.delete(index)
            })
        }
        // Out of range — skip animation, go straight to adjacent section
        if (dir) return doGoTo()
        this.#scrollToPage(page, 'snap')
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
            dx: 0, dy: 0,
            dt: 0,
            page: this.#renderedPage,
        }
        // Hint to browser that scrolling will occur for better GPU layer management
        const pv = this.#primaryView
        if (pv?.element) {
            pv.element.style.willChange = 'transform'
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        // When the host opts out of swipe-to-paginate, let touch events reach
        // native behavior (text selection, etc.) without us tracking or
        // pre-empting them.
        if (this.hasAttribute('no-swipe')) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        const doc = this.#primaryView?.document
        const selection = doc?.getSelection()
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
            return
        }
        const touch = e.changedTouches[0]
        const isStylus = touch.touchType === 'stylus'
        if (!isStylus) e.preventDefault()
        if (this.#scrollLocked) return
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        state.dx += dx
        state.dy += dy
        state.dt += dt
        this.#touchScrolled = true
        if (!this.hasAttribute('animated') || this.hasAttribute('eink')) return
        if (!this.#vertical && Math.abs(state.dx) >= Math.abs(state.dy) && !this.hasAttribute('eink') && (!isStylus || Math.abs(dx) > 1)) {
            this.scrollBy(dx, 0)
        } else if (this.#vertical && Math.abs(state.dx) < Math.abs(state.dy) && !this.hasAttribute('eink') && (!isStylus || Math.abs(dy) > 1)) {
            this.scrollBy(0, dy)
        }
    }
    #onTouchEnd() {
        // Remove will-change hint to free GPU resources
        // if (this.#view?.element) {
        //     this.#view.element.style.willChange = 'auto'
        // }

        if (!this.#touchScrolled) return
        this.#touchScrolled = false
        if (this.scrolled) return
        if (this.hasAttribute('no-swipe')) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        const lifecycleGeneration = this.#lifecycleGeneration
        requestAnimationFrame(() => {
            if (this.#disposed
                || lifecycleGeneration !== this.#lifecycleGeneration) return
            if (globalThis.visualViewport.scale === 1) {
                const { vx, vy, dx, dy, dt } = this.#touchState
                this.snap(vx, vy, dx, dy, dt)
            }
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper(view, direction = {}) {
        const vertical = direction.vertical ?? this.#vertical
        const rtl = direction.rtl ?? this.#rtl
        const sideProp = vertical
            ? (this.scrolled ? 'width' : 'height')
            : (this.scrolled ? 'height' : 'width')
        if (this.scrolled) {
            const size = view
                ? view.element.getBoundingClientRect()[sideProp]
                : this.#renderedViewSize
            const marginTop = this.#marginTop
            const marginBottom = this.#marginBottom
            return vertical
                ? ({ left, right }) =>
                    ({ left: size - right - marginTop, right: size - left - marginBottom })
                : ({ top, bottom }) => ({ left: top - marginTop, right: bottom - marginBottom })
        }
        const pxSize = view
            ? view.element.getBoundingClientRect()[sideProp]
            : this.#renderedPages * this.size
        const mapRect = rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
        if (!rtl && !vertical) {
            mapRect.pointAt = (inline, block) => ({ x: inline, y: block })
        }
        return mapRect
    }
    async #scrollToRect(rect, reason, preparedContents,
        primaryIndex = this.#primaryIndex, prepareRelocation = false,
        beforeCommit) {
        const primaryView = this.#views.get(primaryIndex)
        if (this.scrolled) {
            // rect is in iframe-local coordinates; add view offset
            // to convert to container scroll coordinates
            const localOffset = this.#getRectMapper(primaryView)(rect).left - 3
            const viewOffset = this.#getViewOffset(primaryIndex)
            return this.#scrollToScrolledOffset(
                viewOffset + localOffset,
                reason,
                false,
                preparedContents,
                primaryIndex,
                prepareRelocation,
                beforeCommit,
            )
        }
        // rect is in iframe-local coordinates. Convert to container
        // coordinates by adding the primary view's offset.
        const localOffset = this.#getRectMapper(primaryView)(rect).left
        const viewOffset = this.#getViewOffset(primaryIndex)
        const containerOffset = viewOffset + localOffset
        return this.#scrollToPage(Math.floor(containerOffset / this.size + 0.01),
            reason, false, preparedContents, primaryIndex,
            prepareRelocation, beforeCommit)
    }
    async #scrollTo(offset, reason, smooth, preparedContents, primaryIndex) {
        this.#scrollAnimationController?.abort()
        this.#scrollAnimationController = null
        const scrollAnimationGeneration = ++this.#scrollAnimationGeneration
        const { size } = this
        if (this.containerPosition === offset) {
            this.#isAnimating = false
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason, preparedContents, primaryIndex)
            return true
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth)
            && this.hasAttribute('animated')
            && !this.hasAttribute('eink')
            && canAnimateScroll(this.#container, this.scrollProp)) {
            const startPosition = this.containerPosition
            // Pre-set background for the destination so it's already
            // correct when the slide animation reveals the new page
            if (!this.scrolled) this.#replaceBackground(offset)
            // Use GPU-accelerated scroll animation for smoother experience on high refresh rate screens
            const controller = new AbortController()
            this.#scrollAnimationController = controller
            this.#isAnimating = true
            return animateScroll(
                this.#container,
                this.scrollProp,
                startPosition,
                offset,
                300,
                [],
                controller.signal,
            ).then(committed => {
                if (this.#scrollAnimationController === controller)
                    this.#scrollAnimationController = null
                if (scrollAnimationGeneration !== this.#scrollAnimationGeneration) return
                this.#isAnimating = false
                if (!committed) return false
                this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
                this.#afterScroll(reason, preparedContents, primaryIndex)
                return true
            })
        } else {
            this.#isAnimating = false
            this.containerPosition = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason, preparedContents, primaryIndex)
            return true
        }
    }
    #scrollToScrolledOffset(offset, reason, smooth, preparedContents,
        primaryIndex, prepareRelocation = false, beforeCommit) {
        this.#cancelPreparedRelocation()
        if (preparedContents !== undefined) {
            beforeCommit?.()
            return this.#scrollTo(
                offset, reason, smooth, preparedContents, primaryIndex)
        }
        const changesPrimary = primaryIndex != null
            && primaryIndex !== this.#primaryIndex
        if (!prepareRelocation
            || (this.#renderedStart === Math.abs(offset) && !changesPrimary)) {
            beforeCommit?.()
            return this.#scrollTo(offset, reason, smooth, undefined, primaryIndex)
        }

        const lifecycleGeneration = this.#lifecycleGeneration
        const navigationGeneration = this.#navigationGeneration
        const relocationGeneration = this.#relocationGeneration
        const prepare = () => {
            if (this.#disposed
                || lifecycleGeneration !== this.#lifecycleGeneration
                || navigationGeneration !== this.#navigationGeneration
                || relocationGeneration !== this.#relocationGeneration) return
            const controller = new AbortController()
            this.#prepareRelocateController = controller
            const maxStart = Math.max(0, this.#renderedViewSize - this.size)
            const start = Math.max(0, Math.min(Math.abs(offset), maxStart))
            const contents = this.#getContentsForRenderedWindow(
                start, start + this.size)
            const preparedContents = snapshotPreparedContents(contents)
            const gate = dispatchExtendablePrepareRelocateEvent(
                this, { contents }, controller)
            const commit = ready => {
                if (this.#prepareRelocateController === controller)
                    this.#preparingRelocation = false
                if (this.#disposed
                    || lifecycleGeneration !== this.#lifecycleGeneration
                    || navigationGeneration !== this.#navigationGeneration
                    || relocationGeneration !== this.#relocationGeneration) return
                if (ready === false) {
                    return gate.settled.then(success => {
                        if (!success
                            || this.#prepareRelocateController !== controller
                            || this.#disposed
                            || lifecycleGeneration !== this.#lifecycleGeneration
                            || navigationGeneration !== this.#navigationGeneration
                            || relocationGeneration !== this.#relocationGeneration) return false
                        return this.#scrollToScrolledOffset(
                            offset,
                            reason,
                            smooth,
                            undefined,
                            primaryIndex,
                            prepareRelocation,
                            beforeCommit,
                        )
                    })
                }
                beforeCommit?.()
                return this.#scrollTo(
                    offset, reason, smooth, preparedContents, primaryIndex)
            }
            if (!gate) return commit(true)
            this.#preparingRelocation = true
            return gate.ready.then(commit)
        }
        return prepare()
    }
    #getContentsForRenderedWindow(start, end) {
        const contents = []
        let viewOffset = 0
        for (const [index, view] of this.#sortedViews) {
            const viewSize = view.element.getBoundingClientRect()[this.sideProp]
            const viewEnd = viewOffset + viewSize
            if (viewEnd > start && viewOffset < end && view.document) {
                const range = getVisibleRange(view.document,
                    start - viewOffset, end - viewOffset,
                    this.#getRectMapper(view))
                if (range && !range.collapsed) contents.push({
                    doc: view.document,
                    index,
                    range,
                })
            }
            viewOffset = viewEnd
        }
        return contents
    }
    #getContentsForStagedView(index, view, anchor, direction, layout) {
        if (!view?.document) return []
        const sideProp = direction.vertical
            ? (this.scrolled ? 'width' : 'height')
            : (this.scrolled ? 'height' : 'width')
        const size = this.#container.getBoundingClientRect()[sideProp]
        if (!size) return []
        const mapRect = this.#getRectMapper(view, direction)
        if (this.scrolled) {
            const viewSize = view.element.getBoundingClientRect()[sideProp]
            let start = 0
            if (typeof anchor === 'number') {
                start = anchor * viewSize
            } else {
                const rects = uncollapse(anchor)?.getClientRects?.()
                const rect = rects && (Array.from(rects)
                    .find(r => r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0)
                    || rects[0])
                if (rect) start = mapRect(rect).left - 3
            }
            start = Math.max(0, Math.min(start, Math.max(0, viewSize - size)))
            const range = getVisibleRange(
                view.document,
                start,
                start + size,
                mapRect,
            )
            return range && !range.collapsed
                ? [{ doc: view.document, index, range }]
                : []
        }
        const columnCount = layout?.columnCount ?? 1
        let targetPage = 0
        if (typeof anchor === 'number') {
            const targetColumn = Math.round(
                anchor * Math.max(0, view.contentPages - 1))
            targetPage = Math.floor(targetColumn / columnCount)
        } else {
            const rects = uncollapse(anchor)?.getClientRects?.()
            const rect = rects && (Array.from(rects)
                .find(r => r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0)
                || rects[0])
            if (rect) {
                const localOffset = mapRect(rect).left
                targetPage = Math.floor(Math.max(0, localOffset) / size + 0.01)
            }
        }
        const start = targetPage * size
        const range = getVisibleRange(
            view.document,
            start,
            start + size,
            mapRect,
        )
        return range && !range.collapsed
            ? [{ doc: view.document, index, range }]
            : []
    }
    #cancelPreparedRelocation() {
        this.#relocationGeneration++
        this.#prepareRelocateController?.abort()
        this.#prepareRelocateController = null
        this.#scrollAnimationController?.abort()
        this.#scrollAnimationController = null
        this.#preparingRelocation = false
    }
    #scrollToPage(page, reason, smooth, preparedContents, primaryIndex,
        prepareRelocation = false, beforeCommit) {
        const offset = this.size * (this.#rtl ? -page : page)
        this.#cancelPreparedRelocation()
        if (preparedContents !== undefined) {
            beforeCommit?.()
            return this.#scrollTo(offset, reason, smooth, preparedContents, primaryIndex)
        }
        const changesPrimary = primaryIndex != null
            && primaryIndex !== this.#primaryIndex
        if (this.scrolled || (this.containerPosition === offset && !changesPrimary)
            || (!prepareRelocation && reason !== 'page' && reason !== 'snap')) {
            beforeCommit?.()
            return this.#scrollTo(offset, reason, smooth, undefined, primaryIndex)
        }

        const lifecycleGeneration = this.#lifecycleGeneration
        const navigationGeneration = this.#navigationGeneration
        const relocationGeneration = this.#relocationGeneration
        const prepare = () => {
            if (this.#disposed
                || lifecycleGeneration !== this.#lifecycleGeneration
                || navigationGeneration !== this.#navigationGeneration
                || relocationGeneration !== this.#relocationGeneration) return
            const controller = new AbortController()
            this.#prepareRelocateController = controller
            const start = Math.abs(offset)
            const contents = this.#getContentsForRenderedWindow(start, start + this.size)
            const preparedContents = snapshotPreparedContents(contents)
            const gate = dispatchExtendablePrepareRelocateEvent(this, { contents }, controller)
            const commit = ready => {
                if (this.#prepareRelocateController === controller) {
                    this.#preparingRelocation = false
                }
                if (this.#disposed
                    || lifecycleGeneration !== this.#lifecycleGeneration
                    || navigationGeneration !== this.#navigationGeneration
                    || relocationGeneration !== this.#relocationGeneration) return
                if (ready === false) {
                    // Keep the controller alive so a cold highlight task can
                    // finish without being fenced. Once it settles, retry
                    // from the still-current navigation generation; the cache
                    // is then warm and the second prepare normally commits
                    // synchronously. A cancelled/rejected task does not retry.
                    const retryWhenSettled = gate.settled.then(success => {
                        if (!success
                            || this.#prepareRelocateController !== controller
                            || this.#disposed
                            || lifecycleGeneration !== this.#lifecycleGeneration
                            || navigationGeneration !== this.#navigationGeneration
                            || relocationGeneration !== this.#relocationGeneration) return false
                        return this.#scrollToPage(page, reason, smooth,
                            undefined, primaryIndex, prepareRelocation, beforeCommit)
                    })
                    // Direct goTo navigation must remain pending so its anchor,
                    // focus, trimming and history update stay in the original
                    // commit chain. Page/snap keeps its bounded-return behavior.
                    if (prepareRelocation) return retryWhenSettled
                    void retryWhenSettled
                    return false
                }
                beforeCommit?.()
                return this.#scrollTo(offset, reason, smooth,
                    preparedContents, primaryIndex)
            }
            if (!gate) return commit(true)
            this.#preparingRelocation = true
            return gate.ready.then(commit)
        }
        return prepare()
    }
    async scrollToAnchor(anchor, select, smooth) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation', smooth)
    }
    async #scrollToAnchor(anchor, reason = 'anchor', smooth = false,
        preparedContents, primaryIndex = this.#primaryIndex,
        preserveAnchorUntilCommit = false, prepareRelocation = false) {
        if (!preserveAnchorUntilCommit) this.#anchor = anchor
        const beforeCommit = preserveAnchorUntilCommit
            && (reason === 'navigation' || reason === 'selection'
                || reason === 'anchor')
            ? () => { this.#anchor = anchor }
            : undefined
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0) || rects[0]
            if (!rect) return
            const committed = await this.#scrollToRect(
                rect, reason, preparedContents, primaryIndex,
                prepareRelocation, beforeCommit)
            if (committed === false) return false
            // focus the element when navigating with keyboard or screen reader
            if (reason === 'navigation') {
                let node = anchor.focus ? anchor : undefined
                if (!node && anchor.startContainer) {
                    node = anchor.startContainer
                    if (node.nodeType === Node.TEXT_NODE) {
                        node = node.parentElement
                    }
                }
                if (node && node.focus) {
                    node.tabIndex = -1
                    node.style.outline = 'none'
                    node.focus({ preventScroll: true })
                }
            }
            return committed
        }
        // if anchor is a fraction
        if (this.scrolled) {
            // In scrolled mode with multi-view, offset to the primary view's position
            const primaryOffset = this.#getViewOffset(primaryIndex)
            const primaryView = this.#views.get(primaryIndex)
            const primarySize = primaryView
                ? primaryView.element.getBoundingClientRect()[this.sideProp] : this.#renderedViewSize
            return await this.#scrollToScrolledOffset(
                primaryOffset + anchor * primarySize,
                reason,
                smooth,
                preparedContents,
                primaryIndex,
                prepareRelocation,
                beforeCommit,
            )
        }
        // In paginated mode, account for pages before the primary section
        const primaryView = this.#views.get(primaryIndex)
        if (!primaryView) return
        const pagesBeforePrimary = this.#getPagesBeforeView(primaryIndex)
        const textPages = primaryView.contentPages
        if (!textPages) return
        // textPages is in column units; convert to spread page for scrolling
        const newColumn = Math.round(anchor * (textPages - 1))
        const newSpreadPage = Math.floor(newColumn / this.columnCount)
        return await this.#scrollToPage(
            pagesBeforePrimary + newSpreadPage,
            reason, smooth, preparedContents, primaryIndex,
            prepareRelocation, beforeCommit)
    }
    // Get the pixel offset of a view within the container
    #getViewOffset(index) {
        let offset = 0
        for (const [i, view] of this.#sortedViews) {
            if (i === index) return offset
            offset += view.element.getBoundingClientRect()[this.sideProp]
        }
        return offset
    }
    // Get number of full pages (spreads) before a given view.
    // Uses floor so the view's first column is always on or after
    // the returned page — never rounded past it. The 0.01 tolerance
    // absorbs sub-pixel drift on fractional-DPR devices where
    // getBoundingClientRect() accumulates ~0.0001px errors.
    #getPagesBeforeView(index) {
        return Math.floor(this.#getViewOffset(index) / this.size + 0.01)
    }
    #getVisibleRange() {
        const targetView = this.#primaryView
        if (!targetView?.document) return
        const viewOffset = this.#getViewOffset(this.#primaryIndex)
        if (this.scrolled) {
            // In scrolled mode, the primary view may be scrolled out of
            // the viewport at a section boundary. Try all visible views
            // and return the first valid (non-collapsed) range.
            for (const [index, v] of this.#sortedViews) {
                if (!v.document) continue
                const off = this.#getViewOffset(index)
                const vSize = v.element.getBoundingClientRect()[this.sideProp]
                // Skip views entirely outside the viewport
                if (off + vSize <= this.#renderedStart || off >= this.#renderedEnd) continue
                const range = getVisibleRange(v.document,
                    this.#renderedStart - off, this.#renderedEnd - off,
                    this.#getRectMapper(v))
                if (range && !range.collapsed) return { range, index }
            }
            return
        }
        const range = getVisibleRange(targetView.document,
            this.#renderedStart - viewOffset,
            this.#renderedEnd - viewOffset,
            this.#getRectMapper(targetView))
        return range ? { range, index: this.#primaryIndex } : undefined
    }
    // Determine which view is primary based on scroll position
    #detectPrimaryView() {
        if (this.#views.size <= 1) return
        const visibleStart = this.#renderedStart
        let offset = 0
        for (const [index, view] of this.#sortedViews) {
            const viewSize = view.element.getBoundingClientRect()[this.sideProp]
            if (visibleStart < offset + viewSize - 1) {
                if (index !== this.#primaryIndex) {
                    this.#primaryIndex = index
                    this.#syncA11y()
                    this.#trimDistantViews()
                    this.#replaceBackground()
                    this.#startFill(() => this.#preloadNext())
                }
                return
            }
            offset += viewSize
        }
    }
    #startFill(start) {
        if (this.#fillPromise) return this.#fillPromise
        const task = Promise.resolve().then(start)
        this.#fillPromise = task
        const settle = () => {
            if (this.#fillPromise !== task) return
            this.#fillPromise = null
            this.#stabilizing = false
        }
        void task.then(settle, error => {
            console.warn(error)
            settle()
        })
        return task
    }
    // Pre-load adjacent sections from the current primary so the
    // next/prev sections are ready when the user paginates.
    // Does NOT re-scroll to avoid fighting with the user's current
    // scroll position.
    async #preloadNext() {
        if (this.noPreload || this.noContinuousScroll || this.#filling) return
        this.#filling = true
        try {
            const { size } = this
            const minPages = 5
            const maxSections = 8
            // Load forward sections until we have enough pages ahead
            let iterations = 0
            while (this.#views.size < maxSections && iterations < maxSections) {
                iterations++
                const pagesAhead = size > 0
                    ? Math.floor((this.#renderedViewSize - this.#renderedEnd) / size)
                    : 0
                if (pagesAhead >= minPages) break
                const sorted = this.#sortedViews
                const lastIndex = sorted[sorted.length - 1]?.[0]
                if (lastIndex == null) break
                const nextIdx = this.#adjacentIndex(1, lastIndex)
                if (nextIdx == null) break
                // Stop preloading at writing-mode boundaries
                if (!this.#isSameDirection(nextIdx)) break
                await this.#loadAdjacentSection(nextIdx)
                if (!this.#views.has(nextIdx)) break
            }
            // Wait a frame so ResizeObserver callbacks fire while
            // #filling is still true, preventing onExpand from
            // re-scrolling to a stale anchor position.
            await waitForAnimationFrame()
        } finally {
            this.#filling = false
            this.dispatchEvent(new Event('stabilized'))
        }
    }
    #afterScroll(reason, preparedContents, primaryIndex) {
        // In multi-view, detect which section is primary
        if (primaryIndex != null && this.#views.get(primaryIndex)?.ready) {
            if (this.#primaryIndex !== primaryIndex) {
                this.#primaryIndex = primaryIndex
                this.#syncA11y()
            }
        } else if (this.#views.size > 1
            && reason !== 'anchor' && reason !== 'navigation') {
            this.#detectPrimaryView()
            // Scrolling can bring a previously off-screen view into the
            // viewport (e.g. the next section's first column joining the
            // current section's last column in a dual-page spread) without
            // changing which view is primary. Re-sync a11y attributes so
            // a newly visible view stops being aria-hidden.
            this.#syncA11y()
        }
        const prepared = preparedContents
            ?.find(content => content.index === this.#primaryIndex)
        const visible = prepared && isPreparedRangeCurrent(prepared)
            ? prepared : this.#getVisibleRange()
        const { range, index: visibleIndex } = visible || {}
        if (!range) return
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = visibleIndex ?? this.#primaryIndex
        const primaryView = this.#primaryView
        const detail = { reason, range, index }
        if (this.scrolled) {
            const primaryOffset = this.#getViewOffset(index)
            const primarySize = primaryView
                ? primaryView.element.getBoundingClientRect()[this.sideProp] : this.#renderedViewSize
            detail.fraction = primarySize > 0
                ? Math.max(0, Math.min(1, (this.#renderedStart - primaryOffset) / primarySize)) : 0
        } else if (this.#renderedPages > 0 && primaryView) {
            const page = this.#renderedPage
            const pagesBeforePrimary = this.#getPagesBeforeView(index)
            const textPages = primaryView.contentPages
            this.#header.style.visibility = page > 0 ? 'visible' : 'hidden'
            // page is in spread units, textPages is in column units
            const localPage = page - pagesBeforePrimary
            const localColumn = localPage * this.columnCount
            detail.fraction = textPages > 0 ? Math.max(0, Math.min(1, localColumn / textPages)) : 0
            detail.size = textPages > 0 ? this.columnCount / textPages : 1
            if (reason === 'container-scroll' && localPage === 0) return
        }
        // Update per-column backgrounds for the current scroll position
        if (!this.scrolled) this.#replaceBackground()
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise, navigationGeneration, lifecycleGeneration) {
        const isCurrent = () => this.#isNavigationCurrent(
            navigationGeneration, lifecycleGeneration)
        const previous = {
            primaryIndex: this.#primaryIndex,
            hasReadyView: this.#rendered
                && this.#views.get(this.#primaryIndex)?.ready === true
                && !!this.#views.get(this.#primaryIndex)?.document,
            anchor: this.#anchor,
            vertical: this.#vertical,
            rtl: this.#rtl,
            scrollLeft: this.#container.scrollLeft,
            scrollTop: this.#container.scrollTop,
            opacity: this.#container.style.opacity || '1',
        }
        let createdView
        let loadingOpacity = previous.opacity
        const restorePreviousVisualState = () => {
            if (!isCurrent()) return
            this.#primaryIndex = this.#views.has(previous.primaryIndex)
                ? previous.primaryIndex : this.#sortedViews[0]?.[0] ?? -1
            this.#anchor = previous.anchor
            if (this.#rendered) {
                this.#beforeRender({
                    vertical: previous.vertical,
                    rtl: previous.rtl,
                }, { preserveViews: true })
            }
            this.#container.scrollLeft = previous.scrollLeft
            this.#container.scrollTop = previous.scrollTop
            this.#container.style.opacity = loadingOpacity
            this.#syncA11y()
        }
        const rollback = () => {
            if (createdView && this.#views.get(createdView.index) === createdView.view)
                this.#destroyView(createdView.index)
            if (!isCurrent()) return
            loadingOpacity = previous.opacity
            restorePreviousVisualState()
            this.#preparingRelocation = false
            this.#stabilizing = false
        }
        this.#stabilizing = true
        let payload
        try {
            payload = await promise
        } catch (error) {
            rollback()
            throw error
        }
        if (!isCurrent()) return
        const { index, src, data, anchor, onLoad, select, reason } = payload
        const relocationReason = reason ?? (select ? 'selection' : 'navigation')
        const isPreparedDirectNavigation = relocationReason === 'navigation'
            && previous.hasReadyView
        const isPreparedRelocation = reason === 'page' || reason === 'snap'
            || isPreparedDirectNavigation
        loadingOpacity = isPreparedRelocation ? previous.opacity : '0'
        this.#container.style.opacity = loadingOpacity
        const hasFocus = this.#views.get(previous.primaryIndex)?.document?.hasFocus()
        let targetDirection
        let targetLayout
        if (src) {
            const view = this.#createView(index, true)
            createdView = { index, view }
            const afterLoad = async doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.sections[index].spineProperties?.forEach(
                        prop => doc.documentElement.setAttribute('data-' + prop, ''))
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                await onLoad?.({ doc, index })
            }
            const beforeRender = direction => {
                if (!isCurrent()) return
                targetDirection = direction
                targetLayout = this.#beforeRender(direction, { preserveViews: true })
                return targetLayout
            }
            const afterRender = () => restorePreviousVisualState()
            let loaded
            try {
                loaded = await view.load(
                    src, data, afterLoad, beforeRender, afterRender)
            } catch (error) {
                rollback()
                throw error
            }
            if (!loaded || !isCurrent() || this.#views.get(index) !== view) {
                rollback()
                return
            }
            if (view.document) {
                targetDirection ??= getDirection(view.document)
                this.#directionCache.set(index, targetDirection.vertical)
            }
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
        }
        const targetView = createdView?.view ?? this.#views.get(index)
        if (!targetView?.document || !targetDirection || !targetLayout) {
            rollback()
            return false
        }
        const resolvedAnchor = (typeof anchor === 'function'
            ? anchor(targetView.document) : anchor) ?? 0
        const commitTarget = async preparedContents => {
            if (!isCurrent() || this.#views.get(index) !== targetView) return false
            this.#prepareRelocateController = null
            this.#preparingRelocation = false
            this.#stabilizing = true
            this.#primaryIndex = index
            const stagedLayout = targetLayout
            targetLayout = this.#beforeRender(targetDirection, { preserveViews: true })
            const layoutChanged = !layoutsEqual(stagedLayout, targetLayout)
            if (layoutChanged) targetView.render(targetLayout)
            // The pending view was already rendered with stagedLayout. When
            // it is unchanged, only recompute its extent after highlight DOM
            // insertion; when it changed, render() already expanded it.
            targetView.markReady({ expand: !layoutChanged })
            const canKeepNearbyViews = targetDirection.vertical === previous.vertical
                && !this.noContinuousScroll
            for (const [viewIndex] of this.#views) {
                if (viewIndex === index) continue
                if (canKeepNearbyViews && Math.abs(viewIndex - index) <= 2) continue
                this.#destroyView(viewIndex)
            }
            this.#syncA11y()
            const positioned = await this.#scrollToAnchor(
                resolvedAnchor,
                relocationReason,
                false,
                preparedContents,
                index,
            )
            if (!isCurrent()) return false
            if (positioned === false) return false
            if (hasFocus) this.focusView()
            this.#container.style.opacity = '1'
            this.#rendered = true
            this.dispatchEvent(new Event('stabilized'))
            this.#startFill(() => this.#fillVisibleArea(
                { reanchor: !this.scrolled }))
            return true
        }

        const prepareTarget = () => {
            if (!isCurrent() || this.#views.get(index) !== targetView) return false
            if (!isPreparedRelocation)
                return commitTarget(undefined)
            this.#cancelPreparedRelocation()
            const controller = new AbortController()
            this.#prepareRelocateController = controller
            const contents = this.#getContentsForStagedView(
                index, targetView, resolvedAnchor, targetDirection, targetLayout)
            const preparedContents = snapshotPreparedContents(contents)
            const gate = dispatchExtendablePrepareRelocateEvent(
                this, { contents }, controller)
            const finish = ready => {
                if (this.#prepareRelocateController === controller)
                    this.#preparingRelocation = false
                if (!isCurrent()
                    || this.#prepareRelocateController !== controller
                    || this.#views.get(index) !== targetView) {
                    rollback()
                    return false
                }
                if (ready === false) {
                    if (!isPreparedDirectNavigation) this.#stabilizing = false
                    const retryWhenSettled = gate.settled.then(success => {
                        if (!isCurrent()
                            || this.#prepareRelocateController !== controller
                            || this.#views.get(index) !== targetView) {
                            rollback()
                            return false
                        }
                        if (!success) {
                            rollback()
                            return false
                        }
                        return prepareTarget()
                    })
                    // Keep direct navigation in its original promise chain so
                    // delayed cache replay cannot update history before the
                    // highlighted target is actually committed.
                    if (isPreparedDirectNavigation) return retryWhenSettled
                    void retryWhenSettled.catch(error => {
                        rollback()
                        console.warn(error)
                    })
                    return false
                }
                return commitTarget(preparedContents)
            }
            if (!gate) return commitTarget(preparedContents)
            this.#preparingRelocation = true
            return gate.ready.then(finish)
        }

        return await prepareTarget()
    }
    // Load an adjacent section without changing primary index
    #loadAdjacentSection(index) {
        const pending = this.#sectionLoadPromises.get(index)
        if (pending) return pending
        if (this.#views.has(index) || !this.#canGoToIndex(index)) return Promise.resolve()
        const task = this.#loadAdjacentSectionNow(index, this.#lifecycleGeneration)
        this.#sectionLoadPromises.set(index, task)
        const clear = () => {
            if (this.#sectionLoadPromises.get(index) === task)
                this.#sectionLoadPromises.delete(index)
        }
        void task.then(clear, clear)
        return task
    }
    async #loadAdjacentSectionNow(index, lifecycleGeneration) {
        const section = this.sections[index]
        if (!section || section.linear === 'no') return
        let view
        try {
            const source = await this.#loadSectionSource(index, lifecycleGeneration)
            if (!source) return
            const { src, data } = source
            view = this.#createView(index, true)
            const afterLoad = async doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    section.spineProperties?.forEach(
                        prop => doc.documentElement.setAttribute('data-' + prop, ''))
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                this.setStyles(this.#styles)
                await dispatchExtendableLoadEvent(this, { doc, index })
            }
            // Adjacent sections reuse the primary view's cached layout
            // — they must NOT call #beforeRender, which would modify
            // global state (direction, CSS classes, dir attribute, etc.).
            const cachedLayout = this.#lastLayout
            const beforeRender = () => cachedLayout
            const committed = await view.load(src, data, afterLoad, beforeRender)
            if (!committed || lifecycleGeneration !== this.#lifecycleGeneration
                || this.#views.get(index) !== view) return
            // Cache direction for future preload boundary checks
            if (view.document) {
                const dir = getDirection(view.document)
                this.#directionCache.set(index, dir.vertical)
                // Destroy views with a different writing-mode immediately.
                // Mixed-direction views corrupt scroll/page calculations.
                if (dir.vertical !== this.#vertical) {
                    this.#destroyView(index)
                    return
                }
            }
            view.markReady()
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
        } catch (e) {
            if (view && this.#views.get(index) === view) this.#destroyView(index)
            console.warn(e)
            console.warn(new Error(`Failed to load adjacent section ${index}`))
        }
    }
    // Fill adjacent sections until at least `minPages` pages exist
    // beyond the current viewport in each direction (forward always,
    // backward only when the primary section is short).
    // When reanchor is false (background pre-loading), skip re-scrolling
    // to avoid fighting with the user's current scroll position.
    async #fillVisibleArea({ reanchor = true } = {}) {
        if (this.noPreload || this.noContinuousScroll || this.#filling) return
        this.#filling = true
        try {
            const { size } = this
            if (!size) return
            const minPages = 5
            const maxSections = 8

            // If the primary section is shorter than one spread and
            // there's no section already loaded before it, load the
            // previous section to fill the leading columns
            const primaryView = this.#primaryView
            if (primaryView && primaryView.contentPages > 0
                && primaryView.contentPages < this.columnCount) {
                const sorted = this.#sortedViews
                const firstIndex = sorted[0]?.[0]
                if (firstIndex != null && firstIndex >= this.#primaryIndex) {
                    const prevIdx = this.#adjacentIndex(-1, firstIndex)
                    if (prevIdx != null && this.#isSameDirection(prevIdx)) {
                        await this.#loadAdjacentSection(prevIdx)
                    }
                }
            }

            // Load forward sections until we have enough pages ahead
            let iterations = 0
            while (this.#views.size < maxSections && iterations < maxSections) {
                iterations++
                const pagesAhead = Math.floor(
                    (this.#renderedViewSize - this.#renderedEnd) / size)
                if (pagesAhead >= minPages) break
                const sorted = this.#sortedViews
                const lastIndex = sorted[sorted.length - 1]?.[0]
                if (lastIndex == null) break
                const nextIdx = this.#adjacentIndex(1, lastIndex)
                if (nextIdx == null) break
                // Stop at writing-mode boundaries
                if (!this.#isSameDirection(nextIdx)) break
                await this.#loadAdjacentSection(nextIdx)
                if (!this.#views.has(nextIdx)) break
            }
            if (reanchor) this.#scrollToAnchor(this.#anchor)
        } finally {
            this.#filling = false
            // Emit stabilized so post-layout processing (e.g. warichu)
            // runs for newly loaded adjacent sections.
            this.dispatchEvent(new Event('stabilized'))
        }
    }
    // Trim views whose content is entirely more than 10 pages away
    // from the current viewport. Only removes views AFTER the primary
    // — removing views before would shift scroll position.
    #trimDistantViews() {
        const { size } = this
        if (!size) return
        const maxDistance = size * 10
        const viewportEnd = this.#renderedEnd
        for (const [index, view] of this.#sortedViews) {
            if (index <= this.#primaryIndex) continue
            const offset = this.#getViewOffset(index)
            if (offset - viewportEnd > maxDistance) {
                this.#destroyView(index)
            }
        }
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    #isNavigationCurrent(navigationGeneration, lifecycleGeneration) {
        return !this.#disposed
            && navigationGeneration === this.#navigationGeneration
            && lifecycleGeneration === this.#lifecycleGeneration
    }
    async #loadSectionSource(index, lifecycleGeneration) {
        const section = this.sections[index]
        if (!section) return
        const isCurrent = () => lifecycleGeneration === this.#lifecycleGeneration
        try {
            const src = await withTimeout(
                Promise.resolve().then(() => section.load()),
                SECTION_LOAD_TIMEOUT_MS,
                `Section ${index} load`,
            )
            if (!isCurrent()) {
                section.unload?.()
                return
            }
            const data = section.loadContent
                ? await withTimeout(
                    Promise.resolve().then(() => section.loadContent()),
                    SECTION_LOAD_TIMEOUT_MS,
                    `Section ${index} content load`,
                )
                : undefined
            if (!isCurrent()) {
                section.unload?.()
                return
            }
            return { src, data }
        } catch (error) {
            section.unload?.()
            throw error
        }
    }
    async #goTo({ index, anchor, select, reason }, navigationGeneration, lifecycleGeneration) {
        const isCurrent = () => this.#isNavigationCurrent(
            navigationGeneration, lifecycleGeneration)
        if (!isCurrent()) return
        const pendingSectionLoad = this.#sectionLoadPromises.get(index)
        if (pendingSectionLoad) await pendingSectionLoad
        if (!isCurrent()) return
        // Check if the target section has a different writing-mode.
        // If direction changes, we must destroy all views and do a full
        // rebuild via #display — mixed-direction views cannot coexist.
        let directionChanged = false
        if (this.#views.has(index)) {
            const view = this.#views.get(index)
            if (view?.document) {
                const { vertical } = getDirection(view.document)
                directionChanged = vertical !== this.#vertical
            }
        } else if (this.#directionCache.has(index)) {
            directionChanged = this.#directionCache.get(index) !== this.#vertical
        }
        // When direction is unknown (not cached), #beforeRender will
        // detect and clean up stale views if a change actually occurs.

        if (this.#views.get(index)?.ready && !directionChanged) {
            // View already loaded — reuse it without
            // clearing/reloading. Just change primary and scroll.
            this.#stabilizing = true
            const relocationReason = reason ?? (select ? 'selection' : 'navigation')
            const isPreparedDirectNavigation = relocationReason === 'navigation'
                && this.#rendered && this.#primaryView?.ready === true
                && !!this.#primaryView?.document
            const isPreparedRelocation = reason === 'page' || reason === 'snap'
                || isPreparedDirectNavigation
            if (!isPreparedRelocation) this.#container.style.opacity = '0'
            const previousPrimaryIndex = this.#primaryIndex
            const previousAnchor = this.#anchor
            const hasFocus = this.#primaryView?.document?.hasFocus()
            const targetView = this.#views.get(index)
            if (!isPreparedRelocation) {
                this.#primaryIndex = index
                this.#syncA11y()
            }
            if (!isPreparedRelocation) this.#trimDistantViews()
            // Handle short section alignment
            if (!this.noPreload && !this.noContinuousScroll && targetView
                && targetView.contentPages > 0
                && targetView.contentPages < this.columnCount) {
                const sorted = this.#sortedViews
                const firstIndex = sorted[0]?.[0]
                if (firstIndex != null) {
                    const prevIdx = this.#adjacentIndex(-1, firstIndex)
                    if (prevIdx != null) {
                        await this.#loadAdjacentSection(prevIdx)
                        if (!isCurrent()) return
                    }
                }
            }
            // In noContinuousScroll mode, destroy all non-primary views
            if (this.noContinuousScroll && !isPreparedRelocation) {
                for (const [i] of this.#views) {
                    if (i !== index) this.#destroyView(i)
                }
            }
            const resolvedAnchor = (typeof anchor === 'function'
                ? anchor(targetView.document) : anchor) ?? 0
            const positioned = await this.#scrollToAnchor(
                resolvedAnchor,
                relocationReason,
                false,
                undefined,
                index,
                isPreparedRelocation,
                isPreparedDirectNavigation,
            )
            if (!isCurrent()) return
            if (positioned === false) {
                this.#primaryIndex = this.#views.has(previousPrimaryIndex)
                    ? previousPrimaryIndex : this.#sortedViews[0]?.[0] ?? -1
                this.#anchor = previousAnchor
                this.#syncA11y()
                this.#replaceBackground()
                this.#container.style.opacity = '1'
                this.#stabilizing = false
                if (hasFocus) this.focusView()
                return false
            }
            if (isPreparedRelocation) {
                this.#trimDistantViews()
                if (this.noContinuousScroll) {
                    for (const [i] of this.#views) {
                        if (i !== index) this.#destroyView(i)
                    }
                }
            }
            this.#container.style.opacity = '1'
            if (hasFocus) this.focusView()
            // Load remaining adjacent sections progressively;
            // keep #stabilizing true until fill completes
            this.#startFill(() => this.#fillVisibleArea())
            return true
        } else {
            // Keep the current view until #display has prepared the target.
            // #display atomically commits the target or restores this view.
            const oldIndex = this.#primaryIndex
            const onLoad = async detail => {
                if (oldIndex >= 0 && !this.#views.has(oldIndex))
                    this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                await dispatchExtendableLoadEvent(this, detail)
            }
            return await this.#display(this.#loadSectionSource(index, lifecycleGeneration)
                .then(source => {
                    if (!source) throw new Error(`Section ${index} load was superseded`)
                    const { src, data } = source
                    return { index, src, data, anchor, onLoad, select, reason }
                }).catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    throw e
                }), navigationGeneration, lifecycleGeneration)
        }
    }
    async goTo(target) {
        if (this.#locked || this.#disposed) return
        const lifecycleGeneration = this.#lifecycleGeneration
        const requestGeneration = ++this.#goToRequestGeneration
        const resolved = await target
        if (this.#disposed || lifecycleGeneration !== this.#lifecycleGeneration) return
        if (!this.#canGoToIndex(resolved.index)) return
        if (requestGeneration < this.#latestValidGoToRequest) return
        this.#latestValidGoToRequest = requestGeneration
        this.#cancelPreparedRelocation()

        const active = this.#directNavigationPromises.get(resolved.index)
        if (active && active.kind !== 'snap') {
            try {
                await active.task
            } catch {}
            if (this.#disposed || lifecycleGeneration !== this.#lifecycleGeneration
                || requestGeneration < this.#latestValidGoToRequest) return
        }

        const navigationGeneration = ++this.#navigationGeneration
        const task = this.#goTo(resolved, navigationGeneration, lifecycleGeneration)
        const directNavigation = { navigationGeneration, task }
        this.#directNavigationPromises.set(resolved.index, directNavigation)
        try {
            return await task
        } finally {
            if (this.#directNavigationPromises.get(resolved.index) === directNavigation)
                this.#directNavigationPromises.delete(resolved.index)
        }
    }
    async #scrollPrev(distance) {
        if (this.#views.size === 0) return true
        if (this.scrolled) {
            if (this.#renderedStart > 0) {
                await this.#scrollTo(
                    Math.max(0, this.#renderedStart - (distance ?? this.size)), null, true)
                return false
            }
            return !this.atStart
        }
        if (this.atStart) return
        const page = this.#renderedPage - 1
        // Out of range — skip animation, go straight to previous section
        if (page < 0) return true
        await this.#scrollToPage(page, 'page', true)
        return false
    }
    async #scrollNext(distance) {
        if (this.#views.size === 0) return true
        if (this.scrolled) {
            if (this.#renderedViewSize - this.#renderedEnd > 2) {
                await this.#scrollTo(
                    Math.min(this.#renderedViewSize,
                        distance ? this.#renderedStart + distance : this.#renderedEnd),
                    null, true)
                return false
            }
            return !this.atEnd
        }
        if (this.atEnd) return
        const page = this.#renderedPage + 1
        const pages = this.#renderedPages
        // Out of range — skip animation, go straight to next section
        if (page >= pages) return true
        await this.#scrollToPage(page, 'page', true)
        return false
    }
    get atStart() {
        const sorted = this.#sortedViews
        const firstIndex = sorted[0]?.[0] ?? this.#primaryIndex
        if (this.scrolled) return this.#adjacentIndex(-1, firstIndex) == null && this.#renderedStart <= 0
        return this.#adjacentIndex(-1, firstIndex) == null && this.#renderedPage <= 0
    }
    get atEnd() {
        const sorted = this.#sortedViews
        const lastIndex = sorted[sorted.length - 1]?.[0] ?? this.#primaryIndex
        if (this.scrolled) return this.#adjacentIndex(1, lastIndex) == null && this.#renderedViewSize - this.#renderedEnd <= 2
        return this.#adjacentIndex(1, lastIndex) == null && this.#renderedPage >= this.#renderedPages - 1
    }
    #adjacentIndex(dir, fromIndex) {
        if (fromIndex === undefined) fromIndex = this.#primaryIndex
        for (let index = fromIndex + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        const hasCurrentDirectNavigation = [...this.#directNavigationPromises.values()]
            .some(({ navigationGeneration }) =>
                navigationGeneration === this.#navigationGeneration)
        if (this.#locked || this.#disposed || hasCurrentDirectNavigation
            || (this.#primaryView && !this.#primaryView.ready)) return
        const lifecycleGeneration = this.#lifecycleGeneration
        const navigationGeneration = this.#navigationGeneration
        this.#locked = true
        try {
            const prev = dir === -1
            const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (!this.#isNavigationCurrent(navigationGeneration, lifecycleGeneration)) return
            if (shouldGo) {
                const sorted = this.#sortedViews.filter(
                    ([index]) => !this.#sectionLoadPromises.has(index))
                const edgeIndex = prev
                    ? sorted[0]?.[0] ?? this.#primaryIndex
                    : sorted[sorted.length - 1]?.[0] ?? this.#primaryIndex
                const targetIndex = this.#adjacentIndex(dir, edgeIndex)
                if (targetIndex != null) {
                    this.#cancelPreparedRelocation()
                    const targetNavigationGeneration = ++this.#navigationGeneration
                    // Join only the target section's single-flight load. Farther
                    // background fill work must not delay this page turn.
                    await this.#loadAdjacentSection(targetIndex)
                    if (!this.#isNavigationCurrent(
                        targetNavigationGeneration, lifecycleGeneration)) return
                    await this.#goTo({
                        index: targetIndex,
                        anchor: prev ? () => 1 : () => 0,
                        reason: 'page',
                    }, targetNavigationGeneration, lifecycleGeneration)
                }
            }
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } finally {
            this.#locked = false
        }
    }
    async prev(distance) {
        return await this.#turnPage(-1, distance)
    }
    async next(distance) {
        return await this.#turnPage(1, distance)
    }
    async pan(dx, dy) {
        if (this.#locked) return
        this.#cancelPreparedRelocation()
        this.#locked = true
        this.scrollBy(dx, dy)
        this.#locked = false
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        const contents = []
        for (const [index, view] of this.#sortedViews) {
            if (view.document) contents.push({
                index,
                overlayer: view.overlayer,
                doc: view.document,
            })
        }
        return contents
    }
    setStyles(styles) {
        this.#styles = styles
        for (const [, view] of this.#views) {
            const $$styles = this.#styleMap.get(view.document)
            if (!$$styles) continue
            const [$beforeStyle, $style] = $$styles
            if (Array.isArray(styles)) {
                const [beforeStyle, style] = styles
                $beforeStyle.textContent = beforeStyle
                $style.textContent = style
            } else $style.textContent = styles

            // needed because the resize observer doesn't work in Firefox
            view.document?.fonts?.ready?.then(() => view.expand())
        }

        // NOTE: needs `requestAnimationFrame` in Chromium
        const primaryView = this.#primaryView
        if (primaryView) {
            requestAnimationFrame(() => this.#replaceBackground())
        }
    }
    focusView() {
        this.#primaryView?.document?.defaultView?.focus()
    }
    showLoupe(winX, winY, { isVertical, color, gap, margin, radius, magnification }) {
        this.#primaryView?.showLoupe(winX, winY, { isVertical, color, gap, margin, radius, magnification })
    }
    hideLoupe() {
        this.#primaryView?.hideLoupe()
    }
    destroyLoupe() {
        this.#primaryView?.destroyLoupe()
    }
    destroy() {
        this.#cancelPreparedRelocation()
        this.#disposed = true
        this.#lifecycleGeneration++
        this.#navigationGeneration++
        this.#sectionLoadPromises.clear()
        this.#directNavigationPromises.clear()
        this.#fillPromise = null
        this.#observer.unobserve(this.#container)
        this.#destroyAllViews()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)

export {
    canAnimateScroll as __canAnimateScrollForTest,
    getVisibleRange as __getVisibleRangeForTest,
}
