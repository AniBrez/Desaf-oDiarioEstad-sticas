/**
 * A zoomable world map drawn on canvas. Regions are filled by colour class; the caller decides
 * what the classes mean. Geometry is converted to Path2D once per geodata and reused, so panning
 * and zooming only change the canvas transform.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { mesh } from 'topojson-client';
import type { GeometryCollection, GeometryObject } from 'topojson-specification';
import type { Geo } from '../geo/geo';
import { inverseMercatorX, inverseMercatorY, mercatorX, mercatorY, WORLD_VIEW } from '../geo/mercator';
import { readCssVars, useThemeVersion, useWidth } from '../util/hooks';

export interface MapTarget {
  kind: 'region' | 'country';
  regionIdx: number;
  cc: string;
}

export interface WorldMapProps {
  geo: Geo;
  /** What a hover or click selects. */
  level: 'region' | 'country';
  /** Colour class per region: an index into `colorVars`, or -1 for plain land. */
  classes: Int8Array;
  /** CSS custom property names, one per class. */
  colorVars: string[];
  /** Locations to mark with dots. */
  points?: { lat: number; lng: number }[];
  /**
   * 'coverage' colours a region only where Street View exists (0.25 degree cells), so a huge
   * region with one covered road does not read as a huge coloured area. 'regions' fills them whole.
   */
  paint?: 'coverage' | 'regions';
  tooltip: (target: MapTarget) => ReactNode;
  onPick?: (target: MapTarget) => void;
  ariaLabel: string;
}

type Props = { n: string; c: string };

interface MapGeometry {
  regionPaths: Path2D[];
  /** Every region in one path: the plain land underneath the colours. */
  land: Path2D;
  countryBorders: Path2D;
  regionBorders: Path2D;
  coverage: Path2D | null;
  outlines: Map<string, Path2D>;
  /** Countries with coverage, with their centre and size, for the small-country markers. */
  countries: { cc: string; x: number; y: number; size: number; region: number }[];
}

const geometryCache = new WeakMap<Geo, MapGeometry>();

function linesToPath(lines: number[][][]): Path2D {
  const path = new Path2D();
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const x = mercatorX(line[i][0]), y = mercatorY(line[i][1]);
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
  }
  return path;
}

function getGeometry(geo: Geo): MapGeometry {
  let g = geometryCache.get(geo);
  if (g) return g;
  const regionPaths = geo.regions.map((region) => {
    const path = new Path2D();
    for (const poly of region.polygons) {
      for (const ring of poly) {
        path.moveTo(ring[0], ring[1]);
        for (let i = 2; i < ring.length; i += 2) path.lineTo(ring[i], ring[i + 1]);
        path.closePath();
      }
    }
    return path;
  });
  const land = new Path2D();
  for (const path of regionPaths) land.addPath(path);
  const object = geo.topology.objects.regions as GeometryCollection<Props>;
  const cc = (o: GeometryObject) => (o.properties as Props).c;
  const countryBorders = linesToPath(mesh(geo.topology, object, (a, b) => a === b || cc(a) !== cc(b)).coordinates);
  const regionBorders = linesToPath(mesh(geo.topology, object, (a, b) => a !== b && cc(a) === cc(b)).coordinates);
  const countries = [...geo.countries.values()].filter((c) => c.cells > 0 && c.regions.length > 0 && Number.isFinite(c.bbox[0])).map((c) => {
    const largest = c.regions.reduce((best, i) => {
      const b = geo.regions[i].bbox, bb = geo.regions[best].bbox;
      return (b[2] - b[0]) * (b[3] - b[1]) > (bb[2] - bb[0]) * (bb[3] - bb[1]) ? i : best;
    }, c.regions[0]);
    return {
      cc: c.cc,
      x: (c.bbox[0] + c.bbox[2]) / 2,
      y: (c.bbox[1] + c.bbox[3]) / 2,
      size: Math.max(c.bbox[2] - c.bbox[0], c.bbox[3] - c.bbox[1]),
      region: largest,
    };
  });
  g = { regionPaths, land, countryBorders, regionBorders, coverage: null, outlines: new Map(), countries };
  geometryCache.set(geo, g);
  return g;
}

/** Cells are drawn a hair larger than they are so neighbours leave no seams between them. */
const PAD = 0.00002;

function coveragePath(geo: Geo, g: MapGeometry): Path2D {
  if (g.coverage) return g.coverage;
  const path = new Path2D();
  const { cols, rows, cellDeg, bits } = geo.grid;
  const has = (cell: number) => (bits[cell >> 3] & (1 << (cell & 7))) !== 0;
  for (let row = 0; row < rows; row++) {
    const south = -90 + row * cellDeg;
    if (south + cellDeg < WORLD_VIEW.south || south > WORLD_VIEW.north) continue;
    const y0 = mercatorY(south + cellDeg), y1 = mercatorY(south);
    for (let col = 0; col < cols; col++) {
      if (!has(row * cols + col)) continue;
      let end = col;
      while (end + 1 < cols && has(row * cols + end + 1)) end++;
      path.rect(col / cols - PAD, y0 - PAD, (end - col + 1) / cols + 2 * PAD, y1 - y0 + 2 * PAD);
      col = end;
    }
  }
  g.coverage = path;
  return path;
}

function outlineOf(geo: Geo, g: MapGeometry, cc: string): Path2D {
  let path = g.outlines.get(cc);
  if (!path) {
    const object = geo.topology.objects.regions as GeometryCollection<Props>;
    const inside = (o: GeometryObject) => (o.properties as Props).c === cc;
    path = linesToPath(mesh(geo.topology, object, (a, b) => (a === b ? inside(a) : inside(a) !== inside(b))).coordinates);
    g.outlines.set(cc, path);
  }
  return path;
}

const CHROME_VARS = ['--map-water', '--map-land', '--map-line', '--map-line-soft', '--map-point', '--map-point-ring', '--ink'] as const;
const ASPECT = WORLD_VIEW.bottom - WORLD_VIEW.top;
const MAX_ZOOM = 48;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

interface View { k: number; cx: number; cy: number }
const HOME: View = { k: 1, cx: 0.5, cy: (WORLD_VIEW.top + WORLD_VIEW.bottom) / 2 };

export function WorldMap({ geo, level, classes, colorVars, points, paint = 'coverage', tooltip, onPick, ariaLabel }: WorldMapProps) {
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerRef = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<View>({ ...HOME });
  const frame = useRef(0);
  const [hover, setHover] = useState<{ target: MapTarget; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef(0);
  const showHint = useCallback((text: string) => {
    setHint(text);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 1600);
  }, []);
  const themeVersion = useThemeVersion();
  const geometry = useMemo(() => getGeometry(geo), [geo]);
  const height = Math.round(Math.max(240, Math.min(640, width * ASPECT)));

  // One combined path per colour class: a handful of fills per frame instead of thousands.
  const batches = useMemo(() => {
    const byClass = new Map<number, Path2D>();
    for (let i = 0; i < geo.regions.length; i++) {
      const c = classes[i] ?? -1;
      let path = byClass.get(c);
      if (!path) byClass.set(c, path = new Path2D());
      path.addPath(geometry.regionPaths[i]);
    }
    return byClass;
  }, [geo, geometry, classes]);

  const scale = useCallback(() => Math.min(width, height / ASPECT) * view.current.k, [width, height]);

  const clampView = useCallback(() => {
    const v = view.current;
    v.k = Math.max(1, Math.min(MAX_ZOOM, v.k));
    const s = Math.min(width, height / ASPECT) * v.k;
    const hw = width / (2 * s), hh = height / (2 * s);
    v.cx = 2 * hw >= 1 ? 0.5 : Math.max(hw, Math.min(1 - hw, v.cx));
    v.cy = 2 * hh >= ASPECT ? HOME.cy : Math.max(WORLD_VIEW.top + hh, Math.min(WORLD_VIEW.bottom - hh, v.cy));
  }, [width, height]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current, container = containerRef.current;
    if (!canvas || !container || width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const chrome = readCssVars(container, CHROME_VARS);
    const palette = readCssVars(container, colorVars);
    const v = view.current;
    const s = scale();
    const ox = width / 2 - v.cx * s, oy = height / 2 - v.cy * s;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = chrome['--map-water'];
    ctx.fillRect(0, 0, width, height);

    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    ctx.fillStyle = chrome['--map-land'];
    ctx.fill(geometry.land, 'evenodd');
    if (paint === 'coverage') {
      // Colours go on a separate layer that is then cut down to the covered cells.
      const layer = (layerRef.current ??= document.createElement('canvas'));
      if (layer.width !== canvas.width || layer.height !== canvas.height) {
        layer.width = canvas.width;
        layer.height = canvas.height;
      }
      const lc = layer.getContext('2d')!;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.globalCompositeOperation = 'source-over';
      lc.clearRect(0, 0, layer.width, layer.height);
      lc.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      for (const [c, path] of batches) {
        if (c < 0) continue;
        lc.fillStyle = palette[colorVars[c]] || chrome['--map-land'];
        lc.fill(path, 'evenodd');
      }
      lc.globalCompositeOperation = 'destination-in';
      lc.fillStyle = '#000';
      lc.fill(coveragePath(geo, geometry));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    } else {
      for (const [c, path] of batches) {
        if (c < 0) continue;
        ctx.fillStyle = palette[colorVars[c]] || chrome['--map-land'];
        ctx.fill(path, 'evenodd');
      }
    }
    if (level === 'region' && v.k >= 2.2) {
      ctx.lineWidth = 0.6 / s;
      ctx.strokeStyle = chrome['--map-line-soft'];
      ctx.stroke(geometry.regionBorders);
    }
    ctx.lineWidth = 0.75 / s;
    ctx.strokeStyle = chrome['--map-line'];
    ctx.stroke(geometry.countryBorders);

    const active = hover?.target;
    if (active) {
      ctx.lineWidth = 2 / s;
      ctx.strokeStyle = chrome['--ink'];
      ctx.lineJoin = 'round';
      ctx.stroke(active.kind === 'country' ? outlineOf(geo, geometry, active.cc) : geometry.regionPaths[active.regionIdx]);
    }

    // Screen-space layers: dots and markers keep their size whatever the zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const markerBelow = Math.min(7, s * 0.005);
    for (const c of geometry.countries) {
      if (c.size * s >= markerBelow) continue;
      const cls = classes[c.region] ?? -1;
      const px = c.x * s + ox, py = c.y * s + oy;
      if (px < -6 || py < -6 || px > width + 6 || py > height + 6) continue;
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = cls >= 0 ? palette[colorVars[cls]] || chrome['--map-land'] : chrome['--map-land'];
      ctx.fill();
      ctx.lineWidth = active && active.cc === c.cc ? 2 : 1;
      ctx.strokeStyle = active && active.cc === c.cc ? chrome['--ink'] : chrome['--map-line'];
      ctx.stroke();
    }
    if (points && points.length > 0) {
      // Dots stay small on small maps, or a few thousand of them would hide everything else.
      const r = v.k >= 6 ? 3.2 : v.k >= 2.5 ? 2.6 : Math.max(0.9, Math.min(2, s / 520));
      ctx.fillStyle = chrome['--map-point'];
      ctx.strokeStyle = chrome['--map-point-ring'];
      ctx.lineWidth = 0.75;
      for (const p of points) {
        const px = mercatorX(p.lng) * s + ox, py = mercatorY(p.lat) * s + oy;
        if (px < -4 || py < -4 || px > width + 4 || py > height + 4) continue;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, 2 * Math.PI);
        ctx.fill();
        if (v.k >= 2.5) ctx.stroke();
      }
    }
  }, [width, height, containerRef, colorVars, scale, batches, paint, geo, geometry, level, hover, classes, points]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    clampView();
    draw();
    return () => cancelAnimationFrame(frame.current);
  }, [draw, clampView, themeVersion]);

  // ---- Hit testing ------------------------------------------------------------------------
  const targetAt = useCallback((px: number, py: number): MapTarget | null => {
    const v = view.current;
    const s = scale();
    const ox = width / 2 - v.cx * s, oy = height / 2 - v.cy * s;
    const markerBelow = Math.min(7, s * 0.005);
    for (const c of geometry.countries) {
      if (c.size * s >= markerBelow) continue;
      const dx = c.x * s + ox - px, dy = c.y * s + oy - py;
      if (dx * dx + dy * dy <= 81) return { kind: level, regionIdx: c.region, cc: c.cc };
    }
    const idx = geo.regionAt((px - ox) / s, (py - oy) / s);
    return idx >= 0 ? { kind: level, regionIdx: idx, cc: geo.regions[idx].cc } : null;
  }, [geo, geometry, level, scale, width, height]);

  const zoomAt = useCallback((factor: number, px = width / 2, py = height / 2) => {
    const v = view.current;
    const before = scale();
    const wx = v.cx + (px - width / 2) / before, wy = v.cy + (py - height / 2) / before;
    v.k = Math.max(1, Math.min(MAX_ZOOM, v.k * factor));
    const after = scale();
    v.cx = wx - (px - width / 2) / after;
    v.cy = wy - (py - height / 2) / after;
    clampView();
    schedule();
  }, [width, height, scale, clampView, schedule]);

  // ---- Wheel: zoom only with Ctrl/Cmd (or a trackpad pinch), so the page still scrolls -------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        showHint(`Hold ${isMac ? '⌘' : 'Ctrl'} and scroll to zoom`);
        return;
      }
      event.preventDefault();
      const box = el.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0035)), event.clientX - box.left, event.clientY - box.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); window.clearTimeout(hintTimer.current); };
  }, [containerRef, zoomAt, showHint]);

  // ---- Pointer: drag to pan, two fingers to pinch, hover/tap for the tooltip -----------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; pinch: number | null }>({ moved: false, pinch: null });

  const local = (event: React.PointerEvent) => {
    const box = containerRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    gesture.current.moved = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
    if (event.pointerType !== 'touch' || pointers.current.size === 2) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(event);
    const prev = pointers.current.get(event.pointerId);
    if (prev && (event.pointerType !== 'touch' || pointers.current.size === 2)) {
      const v = view.current;
      const s = scale();
      if (pointers.current.size === 2) {
        pointers.current.set(event.pointerId, p);
        const [a, b] = [...pointers.current.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (gesture.current.pinch) zoomAt(distance / gesture.current.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        gesture.current.pinch = distance;
        gesture.current.moved = true;
        return;
      }
      const dx = p.x - prev.x, dy = p.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) {
        if (Math.hypot(dx, dy) > 2) gesture.current.moved = true;
        v.cx -= dx / s;
        v.cy -= dy / s;
        clampView();
        pointers.current.set(event.pointerId, p);
        if (hover) setHover(null);
        schedule();
      }
      return;
    }
    if (prev) {
      // One finger is left to the page for scrolling; say how to move the map instead.
      if (Math.abs(p.x - prev.x) > 14 && Math.abs(p.x - prev.x) > Math.abs(p.y - prev.y)) {
        gesture.current.moved = true;
        showHint('Use two fingers to move the map');
      }
      return;
    }
    const target = targetAt(p.x, p.y);
    setHover((h) => {
      if (!target) return h ? null : h;
      if (h && h.target.regionIdx === target.regionIdx && h.target.kind === target.kind && Math.abs(h.x - p.x) < 2 && Math.abs(h.y - p.y) < 2) return h;
      return { target, x: p.x, y: p.y };
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(event);
    const wasTap = pointers.current.has(event.pointerId) && !gesture.current.moved && pointers.current.size === 1;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current.pinch = null;
    if (pointers.current.size === 0) setDragging(false);
    if (wasTap) {
      const target = targetAt(p.x, p.y);
      setHover(target ? { target, x: p.x, y: p.y } : null);
      if (target && onPick) onPick(target);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const v = view.current;
    const step = 60 / scale();
    switch (event.key) {
      case '+': case '=': zoomAt(1.6); break;
      case '-': case '_': zoomAt(1 / 1.6); break;
      case '0': view.current = { ...HOME }; clampView(); schedule(); break;
      case 'ArrowLeft': v.cx -= step; clampView(); schedule(); break;
      case 'ArrowRight': v.cx += step; clampView(); schedule(); break;
      case 'ArrowUp': v.cy -= step; clampView(); schedule(); break;
      case 'ArrowDown': v.cy += step; clampView(); schedule(); break;
      default: return;
    }
    event.preventDefault();
  };

  const content = hover ? tooltip(hover.target) : null;
  const flipX = hover ? hover.x > width - 290 : false;
  const flipY = hover ? hover.y > height - 220 : false;

  return (
    <div
      ref={containerRef}
      className={`map${dragging ? ' dragging' : ''}`}
      style={{ height: width ? height : 320 }}
      tabIndex={0}
      role="application"
      aria-label={`${ariaLabel}. Drag to pan, use plus and minus to zoom, arrow keys to move. The same data is available as a table.`}
      onKeyDown={onKeyDown}
      onPointerLeave={() => { if (!dragging) setHover(null); }}
    >
      <canvas
        ref={canvasRef}
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => { const box = containerRef.current!.getBoundingClientRect(); zoomAt(2, e.clientX - box.left, e.clientY - box.top); }}
      />
      <div className="map-controls">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.8)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.8)}>−</button>
        <button type="button" aria-label="Show the whole world" onClick={() => { view.current = { ...HOME }; clampView(); schedule(); }}>⤢</button>
      </div>
      <div className={`map-hint${hint ? ' show' : ''}`} aria-hidden="true">{hint ?? '\u00a0'}</div>
      {hover && content && (
        <div
          className="tooltip"
          style={{
            left: flipX ? undefined : hover.x + 14,
            right: flipX ? width - hover.x + 14 : undefined,
            top: flipY ? undefined : hover.y + 14,
            bottom: flipY ? height - hover.y + 14 : undefined,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

/** Latitude/longitude under a point of the default (un-zoomed) view; exported for tests. */
export function unprojectHome(px: number, py: number, width: number, height: number): [number, number] {
  const s = Math.min(width, height / ASPECT);
  return [inverseMercatorY(HOME.cy + (py - height / 2) / s), inverseMercatorX(HOME.cx + (px - width / 2) / s)];
}
