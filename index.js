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
  res.send("teeinblue-artwork-resizer (Diff-Extraction + Tasche + Tasse + Shirts) läuft.");
});



// ============================================================================
// ======================= DEBUG: NUR DESIGN-EXTRAKTION =======================
// Dieser Endpoint gibt AUSSCHLIESSLICH das extrahierte Design als PNG zurück.
// Kein Placement, kein Mockup, kein Overlay.
// URL-Beispiel:
// /debug-design?url=COMPOSITE_URL&mockup_url=BASE_MOCKUP_URL
// ============================================================================

app.get("/debug-design", async (req, res) => {
  const artworkUrl = req.query.url;          // Composite (Mockup + Design)
  const baseMockupUrl = req.query.mockup_url; // Leeres Mockup

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }

  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  try {
    // Beide Bilder laden
    const compositeBuffer = await loadImage(artworkUrl);
    const baseBuffer = await loadImage(baseMockupUrl);

    // NUR Design extrahieren (keine weitere Verarbeitung!)
    const designBuffer = await extractDesign(baseBuffer, compositeBuffer, 30);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(designBuffer);

  } catch (err) {
    console.error("Fehler in /debug-design:", err);
    res.status(500).json({
      error: "Interner Fehler in /debug-design",
      detail: err.message || String(err),
    });
  }
});

// ===================== ENDE DEBUG DESIGN-EXTRAKTION =========================
// ============================================================================



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

// --------------------- (ALT) GRID-DE-COMPOSITING-LOGIK ---------------------
// (bleibt im File unverändert stehen; wird jetzt nur nicht mehr benutzt)

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
  const smoothedAlpha = new Map();
  for (const [key, alpha] of alphaMap) {
    const [xs, ys] = key.split(",");
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

// --------------------- NEU: DEIN DESIGN-EXTRACTOR (1:1) ---------------------

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Extrahiert das Design durch Pixel-Diff zwischen Base-Mockup und Composite.
 * Ersetzt die alte removeGridBackgroundAdvanced-Funktion.
 *
 * @param {Buffer} baseBuffer  - Leeres Mockup (ohne Design)
 * @param {Buffer} compositeBuffer - Mockup MIT Design drauf
 * @param {number} tolerance - Farbtoleranz (Standard: 30)
 * @returns {Promise<Buffer>} - PNG mit transparentem Hintergrund
 */
async function extractDesign(baseBuffer, compositeBuffer, tolerance = 30) {
  // Beide Bilder laden und auf gleiche Größe bringen und in JPG konvertieren

  
  // ===== PHASE 0: JPG-Konvertierung (Transparenz entfernen) =====
  // Konvertiert beide Bilder zu JPG, damit transparente PNG/WebP-Hintergründe
  // durch einen weißen Hintergrund ersetzt werden.
  baseBuffer = await sharp(baseBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 100 })
    .toBuffer();

  compositeBuffer = await sharp(compositeBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 100 })
    .toBuffer();



  
  const baseMeta = await sharp(baseBuffer).metadata();
  const compMeta = await sharp(compositeBuffer).metadata();

  const width = baseMeta.width;
  const height = baseMeta.height;

  // Base als Raw RGBA
  const baseRaw = await sharp(baseBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Composite auf Base-Größe skalieren falls nötig, dann Raw RGBA
  let compSharp = sharp(compositeBuffer).ensureAlpha();
  if (compMeta.width !== width || compMeta.height !== height) {
    compSharp = compSharp.resize(width, height);
  }
  const compRaw = await compSharp.raw().toBuffer();

  const totalPixels = width * height;

  // Output-Buffer (RGBA)
  const outRaw = Buffer.alloc(totalPixels * 4);

  // Phase 1: Diff-Map berechnen
  const diffMap = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    diffMap[i] = colorDistance(
      baseRaw[idx], baseRaw[idx + 1], baseRaw[idx + 2],
      compRaw[idx], compRaw[idx + 1], compRaw[idx + 2]
    );
  }

  // Phase 2: Alpha und Farbe rekonstruieren
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const dist = diffMap[i];

    if (dist <= tolerance) {
      // Gleicher Pixel → transparent
      outRaw[idx] = 0;
      outRaw[idx + 1] = 0;
      outRaw[idx + 2] = 0;
      outRaw[idx + 3] = 0;
    } else {
      // Design-Pixel → Alpha-Matting
      const alpha = Math.min(1, (dist - tolerance) / (255 - tolerance));

      const bR = baseRaw[idx];
      const bG = baseRaw[idx + 1];
      const bB = baseRaw[idx + 2];
      const cR = compRaw[idx];
      const cG = compRaw[idx + 1];
      const cB = compRaw[idx + 2];

      let fR, fG, fB;
      if (alpha > 0.01) {
        fR = Math.round(Math.min(255, Math.max(0, (cR - (1 - alpha) * bR) / alpha)));
        fG = Math.round(Math.min(255, Math.max(0, (cG - (1 - alpha) * bG) / alpha)));
        fB = Math.round(Math.min(255, Math.max(0, (cB - (1 - alpha) * bB) / alpha)));
      } else {
        fR = cR;
        fG = cG;
        fB = cB;
      }

      outRaw[idx] = fR;
      outRaw[idx + 1] = fG;
      outRaw[idx + 2] = fB;
      outRaw[idx + 3] = Math.round(alpha * 255);
    }
  }

  // Phase 3: Isolierte Rausch-Pixel entfernen
  const alphaChannel = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaChannel[i] = outRaw[i * 4 + 3];
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (alphaChannel[i] === 0) continue;

      let opaqueNeighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = (y + dy) * width + (x + dx);
          if (alphaChannel[ni] > 0) opaqueNeighbors++;
        }
      }

      if (opaqueNeighbors <= 1 && alphaChannel[i] < 128) {
        outRaw[i * 4 + 3] = 0;
      }
    }
  }

  // Phase 4: Connected-Component-Filter (dünne Linien entfernen)
  const visited = new Uint8Array(totalPixels);
  const components = [];

  for (let i = 0; i < totalPixels; i++) {
    if (visited[i] || outRaw[i * 4 + 3] === 0) continue;

    const queue = [i];
    const pixels = [];
    visited[i] = 1;

    while (queue.length > 0) {
      const cur = queue.pop();
      pixels.push(cur);

      const cx = cur % width;
      const cy = (cur - cx) / width;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (visited[ni] || outRaw[ni * 4 + 3] === 0) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }

    components.push({ pixels });
  }

  // Größte Komponente finden
  let largestIdx = 0;
  for (let c = 1; c < components.length; c++) {
    if (components[c].pixels.length > components[largestIdx].pixels.length) {
      largestIdx = c;
    }
  }

  // Kleine, dünne Komponenten entfernen (1.40% Schwelle + Dicke < 4px)
  const mainSize = components.length > 0 ? components[largestIdx].pixels.length : 0;
  const sizeThreshold = Math.max(240, mainSize * 0.40);

  for (let c = 0; c < components.length; c++) {
    const comp = components[c];
    if (comp.pixels.length >= sizeThreshold) continue;

    let cMinX = width, cMaxX = 0, cMinY = height, cMaxY = 0;
    for (const pi of comp.pixels) {
      const px = pi % width;
      const py = (pi - px) / width;
      if (px < cMinX) cMinX = px;
      if (px > cMaxX) cMaxX = px;
      if (py < cMinY) cMinY = py;
      if (py > cMaxY) cMaxY = py;
    }
    const bboxW = cMaxX - cMinX + 1;
    const bboxH = cMaxY - cMinY + 1;
    const maxDim = Math.max(bboxW, bboxH);
    const avgThickness = comp.pixels.length / Math.max(1, maxDim);

    // Nur dünne Strukturen entfernen (< 4px), Text bleibt erhalten
    if (avgThickness < 4) {
      for (const pi of comp.pixels) {
        outRaw[pi * 4] = 0;
        outRaw[pi * 4 + 1] = 0;
        outRaw[pi * 4 + 2] = 0;
        outRaw[pi * 4 + 3] = 0;
      }
    }
  }


  // Phase 4.5: Restaurierungs-Pass — dunkle Design-Pixel wiederherstellen,
  // die fälschlich halbtransparent gemacht wurden weil sie dem Mockup ähneln.
  const survivingMask = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (outRaw[i * 4 + 3] > 0) survivingMask[i] = 1;
  }

  // Maske um 0px erweitern um angrenzende entfernte Pixel einzuschließen
  const dilatedMask = new Uint8Array(survivingMask);
  const dilateRadius = 0;
  for (let y = dilateRadius; y < height - dilateRadius; y++) {
    for (let x = dilateRadius; x < width - dilateRadius; x++) {
      if (survivingMask[y * width + x]) continue;
      let found = false;
      for (let dy = -dilateRadius; dy <= dilateRadius && !found; dy++) {
        for (let dx = -dilateRadius; dx <= dilateRadius && !found; dx++) {
          if (survivingMask[(y + dy) * width + (x + dx)]) {
            found = true;
          }
        }
      }
      if (found) dilatedMask[y * width + x] = 1;
    }
  }

  // Pixel wiederherstellen: innerhalb der Design-Region halbtransparente
  // oder entfernte Pixel mit Originaldaten aus dem Composite ersetzen
  const restoreAlphaThreshold = 230;
  for (let i = 0; i < totalPixels; i++) {
    if (!dilatedMask[i]) continue;
    const idx = i * 4;
    const currentAlpha = outRaw[idx + 3];

    if (currentAlpha >= restoreAlphaThreshold) continue;

    const dist = diffMap[i];
    if (dist <= tolerance * 0.5) continue;

    outRaw[idx] = compRaw[idx];
    outRaw[idx + 1] = compRaw[idx + 1];
    outRaw[idx + 2] = compRaw[idx + 2];
    outRaw[idx + 3] = 255;
  }

  

  // Phase 5: Auto-Crop
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (outRaw[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Als PNG ausgeben (mit Auto-Crop)
  let result = sharp(outRaw, { raw: { width, height, channels: 4 } });

  if (maxX >= minX && maxY >= minY) {
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    result = result.extract({ left: minX, top: minY, width: cropW, height: cropH });
  }

  return result.png().toBuffer();
}

// ========== MAIN FUNCTION (Name bleibt gleich) ==========
// Änderung: erwartet jetzt zusätzlich baseMockupBuffer und nutzt extractDesign statt Grid-Removal
async function removeGridBackgroundAdvanced(compositeBuffer, baseMockupBuffer) {
  return extractDesign(baseMockupBuffer, compositeBuffer, 30);
}

// --------------------- Preview-Erstellung ---------------------

async function makePreviewWithBgRemoval({
  artworkUrl,       // composite: mockup+design (vom Frontend)
  baseMockupUrl,    // base: mockup ohne design (vom Frontend)
  mockupUrl,        // ZIEL-Mockup (unsere festen Upsell-Mockups)
  scale,
  offsetX,
  offsetY,
  overlayUrl, // optional
}) {
  // Composite laden (Mockup + Design)
  const artBuf = await loadImage(artworkUrl);

  // Base Mockup laden (gleiches Mockup ohne Design)
  const baseBuf = await loadImage(baseMockupUrl);

  // NEU: Design extrahieren statt Hintergrund entfernen
  let artTransparent;
  try {
    artTransparent = await removeGridBackgroundAdvanced(artBuf, baseBuf);
  } catch (err) {
    console.error("Design-Extraction Fehler, verwende Fallback:", err);
    artTransparent = await sharp(artBuf).ensureAlpha().png().toBuffer();
  }

  // ZIEL-Mockup laden (für Upsell-Preview)
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

  // Design (und ggf. Overlay) auf ZIEL-Mockup compositen
  const finalBuf = await mockSharp.composite(composites).png().toBuffer();

  return finalBuf;
}

// --------------------- Tote Endpoint ---------------------

app.get("/tote-preview", async (req, res) => {
  const artworkUrl = req.query.url;
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TOTE_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
      mockupUrl: TOTE_MOCKUP_URL,
      scale: 0.33,
      offsetX: 0.32,
      offsetY: 0.42,
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
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "MUG_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
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
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_WHITE_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
      mockupUrl: TEE_WHITE_MOCKUP_URL,
      scale: 0.38,
      offsetX: 0.30,
      offsetY: 0.28,
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
  const baseMockupUrl = req.query.mockup_url;

  if (!artworkUrl || typeof artworkUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
  }
  if (!baseMockupUrl || typeof baseMockupUrl !== "string") {
    return res.status(400).json({ error: "Parameter 'mockup_url' fehlt oder ist ungültig." });
  }

  const cacheKey = "TEE_BLACK_" + artworkUrl + "_" + baseMockupUrl;
  if (previewCache.has(cacheKey)) {
    res.setHeader("Content-Type", "image/png");
    return res.send(previewCache.get(cacheKey));
  }

  try {
    const finalBuffer = await makePreviewWithBgRemoval({
      artworkUrl,
      baseMockupUrl,
      mockupUrl: TEE_BLACK_MOCKUP_URL,
      scale: 0.38,
      offsetX: 0.30,
      offsetY: 0.28,
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
