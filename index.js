// index.js
import express from "express";
import fetch from "node-fetch";
import sharp from "sharp";

const app = express();

// Shopify CDN mag Browser-User-Agent
const SHOPIFY_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/png,image/*,*/*",
};

// Mockups (aktualisiert wie im zweiten Backend)
const TOTE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1902.jpg?v=1765218360";

const MUG_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1901.jpg?v=1765218358";

// NEU: T-Shirt Mockups
const TEE_WHITE_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1926.jpg?v=1765367168";

const TEE_BLACK_MOCKUP_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/IMG_1924.jpg?v=1765367167";

// NEU: Overlays für T-Shirts (PNG oben drauf)
const TEE_WHITE_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_wei_e_Shirt.png?v=1765367191";

const TEE_BLACK_OVERLAY_URL =
  "https://cdn.shopify.com/s/files/1/0958/7346/6743/files/ber_schwarze_Shirt.png?v=1765367224";

// Cache: artworkUrl + type -> fertiges PNG
const previewCache = new Map();

// Healthcheck
app.get("/", (req, res) => {
  res.send("teeinblue-artwork-resizer (BG-Removal + Tasche + Tasse) läuft.");
});

// --------------------- Hilfsfunktionen ---------------------

async function loadImage(url) {
  const resp = await fetch(url, { headers: SHOPIFY_FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Bild konnte nicht geladen werden: ${url} (HTTP ${resp.status})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function colorDist(c1, c2) {
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function brightness(c) {
  return (c[0] + c[1] + c[2]) / 3;
}



// --------------------- NEUE GRID-DE-COMPOSITING-LOGIK ---------------------


const MAX_BLOCK_SIZE = 6;
const MIN_BLOCK_SIZE = 1;
const WHITE_R = 255, WHITE_G = 255, WHITE_B = 255;
const GRAY_R = 204, GRAY_G = 204, GRAY_B = 204;
const COLOR_TOLERANCE = 18;
const EXTENDED_TOLERANCE = 35;

function colorMatches(r, g, b, tR, tG, tB, tol) {
  return Math.abs(r - tR) <= tol && Math.abs(g - tG) <= tol && Math.abs(b - tB) <= tol;
}
function isWhitePixel(r, g, b, tol = COLOR_TOLERANCE) {
  return colorMatches(r, g, b, WHITE_R, WHITE_G, WHITE_B, tol);
}
function isGrayPixel(r, g, b, tol = COLOR_TOLERANCE) {
  return colorMatches(r, g, b, GRAY_R, GRAY_G, GRAY_B, tol);
}
function isGridColor(r, g, b, tol = COLOR_TOLERANCE) {
  return isWhitePixel(r, g, b, tol) || isGrayPixel(r, g, b, tol);
}
function isPotentialOverlaidGrid(r, g, b) {
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return (luminance > 180 && saturation < 60) || isGridColor(r, g, b, EXTENDED_TOLERANCE);
}

function px(raw, width, x, y) {
  const i = (y * width + x) * 4;
  return { r: raw[i], g: raw[i + 1], b: raw[i + 2], a: raw[i + 3] };
}

function isUniformGridRegion(raw, width, height, sx, sy, rw, rh) {
  if (sx + rw > width || sy + rh > height) return { isUniform: false, isWhite: false };
  const f = px(raw, width, sx, sy);
  const firstWhite = isWhitePixel(f.r, f.g, f.b);
  const firstGray = isGrayPixel(f.r, f.g, f.b);
  if (!firstWhite && !firstGray) return { isUniform: false, isWhite: false };
  let match = 0, total = rw * rh;
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const p = px(raw, width, sx + x, sy + y);
      if ((firstWhite && isWhitePixel(p.r, p.g, p.b)) || (firstGray && isGrayPixel(p.r, p.g, p.b))) match++;
    }
  return { isUniform: match / total >= 0.85, isWhite: firstWhite };
}

function detectBlockDimensions(raw, width, height, sx, sy) {
  const f = px(raw, width, sx, sy);
  const isW = isWhitePixel(f.r, f.g, f.b);
  const isG = isGrayPixel(f.r, f.g, f.b);
  if (!isW && !isG) return null;
  let bw = 1;
  for (let x = 1; x <= MAX_BLOCK_SIZE && sx + x < width; x++) {
    const p = px(raw, width, sx + x, sy);
    if (isW ? isWhitePixel(p.r, p.g, p.b) : isGrayPixel(p.r, p.g, p.b)) bw = x + 1; else break;
  }
  let bh = 1;
  for (let y = 1; y <= MAX_BLOCK_SIZE && sy + y < height; y++) {
    const p = px(raw, width, sx, sy + y);
    if (isW ? isWhitePixel(p.r, p.g, p.b) : isGrayPixel(p.r, p.g, p.b)) bh = y + 1; else break;
  }
  const region = isUniformGridRegion(raw, width, height, sx, sy, bw, bh);
  if (!region.isUniform) return null;
  return { width: bw, height: bh, isWhite: isW };
}

function hasAlternatingNeighbors(raw, width, height, bx, by, bw, bh, isWhite) {
  let alt = 0, total = 0;
  const checks = [
    [bx + bw, by], [bx, by + bh], [bx - 1, by], [bx, by - 1]
  ];
  for (const [cx, cy] of checks) {
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
    const p = px(raw, width, cx, cy);
    const pW = isWhitePixel(p.r, p.g, p.b), pG = isGrayPixel(p.r, p.g, p.b);
    if (pW || pG) total++;
    if ((isWhite && pG) || (!isWhite && pW)) alt++;
  }
  return total >= 2 && alt >= 2;
}

function detectLargeContiguousRegions(raw, width, height) {
  const isLarge = Array(height).fill(null).map(() => Array(width).fill(false));
  const visited = Array(height).fill(null).map(() => Array(width).fill(false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (visited[y][x]) continue;
      const p = px(raw, width, x, y);
      if (!isGridColor(p.r, p.g, p.b)) continue;
      const isW = isWhitePixel(p.r, p.g, p.b);
      const region = [];
      const stack = [{ x, y }];
      while (stack.length) {
        const c = stack.pop();
        if (c.x < 0 || c.x >= width || c.y < 0 || c.y >= height) continue;
        if (visited[c.y][c.x]) continue;
        const cp = px(raw, width, c.x, c.y);
        if (!(isW ? isWhitePixel(cp.r, cp.g, cp.b) : isGrayPixel(cp.r, cp.g, cp.b))) continue;
        visited[c.y][c.x] = true;
        region.push(c);
        stack.push({ x: c.x + 1, y: c.y }, { x: c.x - 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x, y: c.y - 1 });
      }
      if (region.length >= 200) {
        let minX = width, maxX = 0, minY = height, maxY = 0;
        for (const p of region) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
        const ar = Math.max(maxX - minX + 1, maxY - minY + 1) / Math.min(maxX - minX + 1, maxY - minY + 1);
        if (region.length > 500 || ar > 2) for (const p of region) isLarge[p.y][p.x] = true;
      }
    }
  }
  return isLarge;
}

function fitsGridPattern(x, y, r, g, b, tol = COLOR_TOLERANCE) {
  const blockX = Math.floor(x / 6), blockY = Math.floor(y / 6);
  const expectedWhite = (blockX + blockY) % 2 === 0;
  return expectedWhite ? isWhitePixel(r, g, b, tol) : isGrayPixel(r, g, b, tol);
}

function detectGridPattern(raw, width, height) {
  const mask = Array(height).fill(null).map(() => Array(width).fill(false));
  const processed = Array(height).fill(null).map(() => Array(width).fill(false));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (processed[y][x]) continue;
      const block = detectBlockDimensions(raw, width, height, x, y);
      if (block && block.width >= MIN_BLOCK_SIZE && block.height >= MIN_BLOCK_SIZE) {
        if (hasAlternatingNeighbors(raw, width, height, x, y, block.width, block.height, block.isWhite)) {
          for (let by = 0; by < block.height; by++)
            for (let bx = 0; bx < block.width; bx++)
              if (y + by < height && x + bx < width) { mask[y + by][x + bx] = true; processed[y + by][x + bx] = true; }
        }
      }
    }
  return mask;
}

function expandFromConfirmedGrid(raw, width, height, gridMask, largeRegions) {
  const expanded = gridMask.map(r => [...r]);
  let changed = true, iter = 0;
  while (changed && iter < 5) {
    changed = false; iter++;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (expanded[y][x] || largeRegions[y][x]) continue;
        const p = px(raw, width, x, y);
        if (!isGridColor(p.r, p.g, p.b, EXTENDED_TOLERANCE)) continue;
        let hasN = false, nWhite = false;
        outer: for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && expanded[ny][nx]) {
              hasN = true; const np = px(raw, width, nx, ny);
              nWhite = isWhitePixel(np.r, np.g, np.b, EXTENDED_TOLERANCE); break outer;
            }
          }
        if (!hasN) continue;
        const pW = isWhitePixel(p.r, p.g, p.b, EXTENDED_TOLERANCE);
        const pG = isGrayPixel(p.r, p.g, p.b, EXTENDED_TOLERANCE);
        const shouldBeW = !nWhite;
        if ((shouldBeW && pW) || (!shouldBeW && pG) || fitsGridPattern(x, y, p.r, p.g, p.b, EXTENDED_TOLERANCE)) {
          expanded[y][x] = true; changed = true;
        }
      }
  }
  return expanded;
}

function detectOverlaidGrid(raw, width, height, gridMask, largeRegions) {
  const mask = gridMask.map(r => [...r]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (mask[y][x] || largeRegions[y][x]) continue;
      const p = px(raw, width, x, y);
      if (!isPotentialOverlaidGrid(p.r, p.g, p.b)) continue;
      let near = 0, checked = 0;
      for (let dy = -12; dy <= 12; dy += 2)
        for (let dx = -12; dx <= 12; dx += 2) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) { checked++; if (mask[ny][nx]) near++; }
        }
      if (checked > 0 && near / checked > 0.3 && isGridColor(p.r, p.g, p.b, EXTENDED_TOLERANCE))
        mask[y][x] = true;
    }
  return mask;
}

function isPartOfDesign(raw, width, height, x, y, gridMask) {
  let nonGrid = 0, total = 0;
  for (let dy = -8; dy <= 8; dy++)
    for (let dx = -8; dx <= 8; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      total++;
      const p = px(raw, width, nx, ny);
      if (!isGridColor(p.r, p.g, p.b)) nonGrid++;
    }
  return total > 0 && nonGrid / total > 0.3;
}

function refineGridMask(raw, width, height, gridMask, largeRegions) {
  const refined = Array(height).fill(null).map(() => Array(width).fill(false));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (largeRegions[y][x]) continue;
      if (gridMask[y][x] && !isPartOfDesign(raw, width, height, x, y, gridMask)) {
        let gn = 0, tn = 0;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) { tn++; if (gridMask[ny][nx]) gn++; }
          }
        if (tn > 0 && gn / tn > 0.35) refined[y][x] = true;
      }
    }
  return refined;
}

function findContrastEdge(raw, width, height, x, y, dirX, dirY) {
  let d = 0;
  while (d < MAX_BLOCK_SIZE) {
    const nx = x + dirX * d, ny = y + dirY * d;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
    const p = px(raw, width, nx, ny);
    if (!isGridColor(p.r, p.g, p.b, EXTENDED_TOLERANCE)) return d;
    d++;
  }
  return d;
}

function applyPartialRemoval(raw, width, height, gridMask, largeRegions) {
  const mask = gridMask.map(r => [...r]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!gridMask[y][x] || largeRegions[y][x]) continue;
      const p = px(raw, width, x, y);
      if (!isGridColor(p.r, p.g, p.b)) continue;
      let nearDesign = false;
      for (let dy = -3; dy <= 3 && !nearDesign; dy++)
        for (let dx = -3; dx <= 3 && !nearDesign; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const np = px(raw, width, nx, ny);
            if (!isGridColor(np.r, np.g, np.b) || largeRegions[ny][nx]) nearDesign = true;
          }
        }
      if (nearDesign) {
        const minEdge = Math.min(
          findContrastEdge(raw, width, height, x, y, 0, -1),
          findContrastEdge(raw, width, height, x, y, 0, 1),
          findContrastEdge(raw, width, height, x, y, -1, 0),
          findContrastEdge(raw, width, height, x, y, 1, 0)
        );
        if (minEdge <= 1) mask[y][x] = false;
      }
    }
  return mask;
}

function protectDesignEdges(raw, width, height, gridMask, largeRegions) {
  const mask = gridMask.map(r => [...r]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = px(raw, width, x, y);
      if (!isGridColor(p.r, p.g, p.b) || largeRegions[y][x]) {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const np = px(raw, width, nx, ny);
              if (isWhitePixel(np.r, np.g, np.b) || isGrayPixel(np.r, np.g, np.b)) {
                let conn = 0;
                for (let cy = -1; cy <= 1; cy++)
                  for (let cx = -1; cx <= 1; cx++) {
                    const ccx = nx + cx, ccy = ny + cy;
                    if (ccx >= 0 && ccx < width && ccy >= 0 && ccy < height && mask[ccy][ccx]) conn++;
                  }
                if (conn < 3) mask[ny][nx] = false;
              }
            }
          }
      }
    }
  return mask;
}

function applyEdgeSmoothing(raw, width, height, gridMask, largeRegions) {
  const smoothed = gridMask.map(r => [...r]);
  const alphaMap = new Map();
  const edgePixels = [];
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      if (!gridMask[y][x]) continue;
      let isEdge = false;
      for (let dy = -1; dy <= 1 && !isEdge; dy++)
        for (let dx = -1; dx <= 1 && !isEdge; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (!gridMask[ny][nx] && !largeRegions[ny][nx]) {
            const np = px(raw, width, nx, ny);
            if (!isGridColor(np.r, np.g, np.b, EXTENDED_TOLERANCE)) isEdge = true;
          }
        }
      if (isEdge) edgePixels.push({ x, y });
    }
  for (const { x, y } of edgePixels) {
    let removed = 0, preserved = 0, design = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          if (gridMask[ny][nx]) removed++; else {
            preserved++;
            const np = px(raw, width, nx, ny);
            if (!isGridColor(np.r, np.g, np.b)) design++;
          }
        }
      }
    const total = removed + preserved;
    if (total > 0 && design > 0) {
      const base = (preserved / total) * 0.7 + (design / 8) * 0.3;
      if (base > 0.15 && base < 0.85) alphaMap.set(`${x},${y}`, Math.round(base * 255));
      else if (base >= 0.85) smoothed[y][x] = false;
    }
  }
  // Gaussian-like smoothing pass
  const smoothedAlpha = new Map();
  for (const [key, alpha] of alphaMap) {
    const [xs, ys] = key.split(',');
    let total = alpha, count = 1;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nk = `${parseInt(xs) + dx},${parseInt(ys) + dy}`;
        if (alphaMap.has(nk)) { total += alphaMap.get(nk); count++; }
      }
    smoothedAlpha.set(key, Math.round(total / count));
  }
  return { mask: smoothed, alphaMap: smoothedAlpha };
}

function applyEdgeFeathering(raw, width, height, gridMask, alphaMap) {
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const key = `${x},${y}`;
      if (alphaMap.has(key) || !gridMask[y][x]) continue;
      let hasAN = false, avgA = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nk = `${x + dx},${y + dy}`;
          if (alphaMap.has(nk)) { hasAN = true; avgA += alphaMap.get(nk); cnt++; }
        }
      if (hasAN && cnt > 0) {
        const fa = Math.round((avgA / cnt) * 0.5);
        if (fa > 10) alphaMap.set(key, fa);
      }
    }
}

// ========== MAIN FUNCTION ==========
async function removeGridBackgroundAdvanced(inputBuffer) {
  const img = sharp(inputBuffer).ensureAlpha();
  const { width, height } = await img.metadata();
  if (!width || !height) throw new Error("Ungültige Bildgröße");

  const raw = await img.raw().toBuffer();

  // Phase 0: Large region detection (text protection)
  const largeRegions = detectLargeContiguousRegions(raw, width, height);

  // Phase 1: Detect grid pattern
  const initialMask = detectGridPattern(raw, width, height);

  // Phase 2: Expand from confirmed grid
  const expandedMask = expandFromConfirmedGrid(raw, width, height, initialMask, largeRegions);

  // Phase 3: Detect grid under overlays
  const overlaidMask = detectOverlaidGrid(raw, width, height, expandedMask, largeRegions);

  // Phase 4: Refine detection
  const refinedMask = refineGridMask(raw, width, height, overlaidMask, largeRegions);

  // Phase 5: Partial removal near edges
  const partialMask = applyPartialRemoval(raw, width, height, refinedMask, largeRegions);

  // Phase 6: Protect design edges
  const protectedMask = protectDesignEdges(raw, width, height, partialMask, largeRegions);

  // Phase 7: Edge smoothing
  const { mask: smoothedMask, alphaMap } = applyEdgeSmoothing(raw, width, height, protectedMask, largeRegions);

  // Phase 8: Edge feathering
  applyEdgeFeathering(raw, width, height, smoothedMask, alphaMap);

  // Apply transparency
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const key = `${x},${y}`;
      const idx = (y * width + x) * 4;
      if (alphaMap.has(key)) {
        raw[idx + 3] = Math.min(raw[idx + 3], alphaMap.get(key));
      } else if (smoothedMask[y][x]) {
        raw[idx + 3] = 0;
      }
    }

  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}





// --------------------- Preview-Erstellung ---------------------

async function makePreviewWithBgRemoval({
  artworkUrl,
  mockupUrl,
  scale,
  offsetX,
  offsetY,
  overlayUrl, // optional
}) {
  // Artwork laden
  const artBuf = await loadImage(artworkUrl);

  // NEU: Grid-De-Compositing statt Flood-Fill
  let artTransparent;
  try {
    artTransparent = await removeGridBackgroundAdvanced(artBuf);
  } catch (err) {
    console.error("BG-Removal Fehler, verwende Original mit Alpha:", err);
    artTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  // Mockup laden
  const mockBuf = await loadImage(mockupUrl);
  const mockSharp = sharp(mockBuf);
  const meta = await mockSharp.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("Konnte Mockup-Größe nicht lesen.");
  }

  // Artwork skalieren
  const scaled = await sharp(artTransparent)
    .resize(Math.round(meta.width * scale), null, {
      fit: "inside",
      fastShrinkOnLoad: true,
    })
    .png()
    .toBuffer();

  const left = Math.round(meta.width * offsetX);
  const top = Math.round(meta.height * offsetY);

  const composites = [{ input: scaled, left, top }];

  // Falls Overlay gesetzt: PNG über alles legen
  if (overlayUrl) {
    const overlayBuf = await loadImage(overlayUrl);
    const overlayPng = await sharp(overlayBuf).ensureAlpha().png().toBuffer();
    composites.push({
      input: overlayPng,
      left: 0,
      top: 0,
    });
  }

  // Artwork (und ggf. Overlay) auf Mockup compositen
  const finalBuf = await mockSharp.composite(composites).png().toBuffer();

  return finalBuf;
}

// --------------------- Tote Endpoint ---------------------

app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TOTE_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: TOTE_MOCKUP_URL,
      scale: 0.42,
      offsetX: 0.26,
      offsetY: 0.46,
      overlayUrl: undefined,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tote-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tote-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- Mug Endpoint ---------------------

app.get("/mug-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "MUG_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: MUG_MOCKUP_URL,
      scale: 0.325,
      offsetX: 0.35,
      offsetY: 0.39,
      overlayUrl: undefined,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /mug-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /mug-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- NEU: Tee weiß Endpoint ---------------------

app.get("/tee-white-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_WHITE_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: TEE_WHITE_MOCKUP_URL,
      scale: 0.36,
      offsetX: 0.31,
      offsetY: 0.26,
      overlayUrl: TEE_WHITE_OVERLAY_URL,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tee-white-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tee-white-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- NEU: Tee schwarz Endpoint ---------------------

app.get("/tee-black-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_BLACK_" + artworkUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      mockupUrl: TEE_BLACK_MOCKUP_URL,
      scale: 0.36,
      offsetX: 0.31,
      offsetY: 0.26,
      overlayUrl: TEE_BLACK_OVERLAY_URL,
    });

    previewCache.set(cacheKey, finalBuffer);
    res.setHeader("Content-Type", "image/png");
    res.send(finalBuffer);
  } catch (err) {
    console.error("Fehler in /tee-black-preview:", err);
    res.status(500).json({
      error: "Interner Fehler in /tee-black-preview",
      detail: err.message || String(err),
    });
  }
});

// --------------------- Serverstart ---------------------

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server läuft auf Port " + PORT);
});
