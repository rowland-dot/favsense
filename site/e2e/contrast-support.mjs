// Colour maths shared by the focus-ring and text-legibility regressions.
// Computed colours come out of the browser as strings; everything here runs in Node on those strings.

export function parseColor(value) {
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/);
  if (rgb) return { channels: rgb.slice(1, 4).map(Number), alpha: Number(rgb[4] ?? 1) };
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/);
  if (srgb) {
    return { channels: srgb.slice(1, 4).map((channel) => Number(channel) * 255), alpha: Number(srgb[4] ?? 1) };
  }
  throw new Error(`Unsupported computed color: ${value}`);
}

export function luminance(channels) {
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

export function contrastRatio(firstChannels, secondChannels) {
  const first = luminance(firstChannels);
  const second = luminance(secondChannels);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

// Lays a translucent colour over an opaque one and returns the opaque result.
export function compositeOver(top, bottomChannels) {
  return top.channels.map((channel, index) => (channel * top.alpha) + (bottomChannels[index] * (1 - top.alpha)));
}

// Flattens a stack of background colours (innermost first) into the opaque colour a reader sees.
export function resolveBackground(backgroundsInnermostFirst, canvasChannels) {
  return [...backgroundsInnermostFirst].reverse().reduce(
    (below, value) => compositeOver(parseColor(value), below),
    canvasChannels
  );
}

// Runs inside the page (pass it to evaluate); it must stay self-contained.
// Returns the computed background colours from the element (or its parent) up to <html>, innermost first.
export function backgroundsFromElement(element, includeSelf) {
  const backgrounds = [];
  for (let node = includeSelf ? element : element.parentElement; node; node = node.parentElement) {
    backgrounds.push(getComputedStyle(node).backgroundColor);
  }
  return backgrounds;
}
