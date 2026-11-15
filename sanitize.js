// Book content is rendered in a same-origin iframe so pagination can measure
// it. That means any script shipped inside an EPUB/FB2/MOBI file would run with
// the reader's own privileges. Strip executable content before it reaches the
// iframe; foliate-js only needs the document structure, styles, and media.

const DANGEROUS_ELEMENTS = [
    'script',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'applet',
    'base',
]

const URL_ATTRIBUTES = new Set([
    'href',
    'src',
    'poster',
    'data',
    'action',
    'formaction',
])

const XLINK_NS = 'http://www.w3.org/1999/xlink'

const isExecutableURL = value => {
    const normalized = value
        .replace(/[\u0000-\u0020]+/g, '')
        .toLowerCase()
    return normalized.startsWith('javascript:')
        || normalized.startsWith('vbscript:')
        || normalized.startsWith('data:text/html')
}

export const sanitizeDocument = doc => {
    if (!doc?.documentElement) return doc

    for (const element of doc.querySelectorAll(
        DANGEROUS_ELEMENTS.join(',')))
        element.remove()

    for (const element of doc.querySelectorAll('*')) {
        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase()
            if (name.startsWith('on') || name === 'srcdoc') {
                element.removeAttribute(attribute.name)
                continue
            }
            if (attribute.namespaceURI === XLINK_NS
                && attribute.localName === 'href') {
                if (isExecutableURL(attribute.value))
                    element.removeAttributeNS(XLINK_NS, 'href')
                continue
            }
            if (URL_ATTRIBUTES.has(name) && isExecutableURL(attribute.value))
                element.removeAttribute(attribute.name)
        }
    }

    for (const meta of doc.querySelectorAll('meta[http-equiv]')) {
        if (meta.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh')
            meta.remove()
    }

    return doc
}
