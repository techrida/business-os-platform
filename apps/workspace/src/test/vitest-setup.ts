// jsdom does not implement layout geometry on Range/Text/Element. ProseMirror/Tiptap calls
// getClientRects() and getBoundingClientRect() on Range, Text, and Element nodes when
// scrolling selections into view; stubbing missing methods keeps jsdom tests from throwing
// uncaught TypeErrors on asynchronous editor ticks.
function emptyRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this;
    },
  };
}

function emptyRectList(): DOMRectList {
  const list = Object.assign([] as DOMRect[], {
    item: () => null,
  });
  return list;
}

if (typeof Range !== 'undefined') {
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = emptyRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = emptyRect;
  }
}

if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.getClientRects !== 'function') {
    Element.prototype.getClientRects = emptyRectList;
  }
  if (typeof Element.prototype.getBoundingClientRect !== 'function') {
    Element.prototype.getBoundingClientRect = emptyRect;
  }
}

if (typeof Text !== 'undefined') {
  const proto = Text.prototype as Text & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof proto.getClientRects !== 'function') {
    proto.getClientRects = emptyRectList;
  }
  if (typeof proto.getBoundingClientRect !== 'function') {
    proto.getBoundingClientRect = emptyRect;
  }
}

// jsdom has no scrollIntoView; the member and option lists call it to keep the highlighted row visible.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}
