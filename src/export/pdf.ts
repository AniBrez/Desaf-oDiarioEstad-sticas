/**
 * PDF export of a chart or map: one A4 landscape page with the title, a context line, the legend,
 * the graphic itself and the data sources. SVG charts are converted to vector drawings (text
 * stays text); canvas maps are embedded as high-resolution images. Colours always come from the
 * light theme, whatever the page is showing.
 *
 * This module (with jsPDF and svg2pdf) is loaded only when someone exports.
 */
import { jsPDF } from 'jspdf';
import { svg2pdf } from 'svg2pdf.js';

export interface PdfLegendItem {
  label: string;
  /** Any CSS colour, including var(--token). */
  color: string;
  kind?: 'line' | 'dashed' | 'dot' | 'band' | 'box';
}

export interface PdfScale {
  title: string;
  /** CSS colours, lowest class first. */
  colors: string[];
  /** Labels at the class boundaries: one more than colours. */
  breaks: string[];
}

export interface PdfBar {
  label: string;
  value: number;
  display: string;
}

export type PdfGraphic =
  | { kind: 'svg'; svg: SVGSVGElement }
  | { kind: 'canvas'; canvas: HTMLCanvasElement }
  | { kind: 'bars'; rows: PdfBar[]; max: number };

export interface PdfSpec {
  title: string;
  subtitle?: string;
  /** Player, period and so on. */
  context?: string;
  legend?: PdfLegendItem[];
  scale?: PdfScale;
  graphic: PdfGraphic;
  notes?: string[];
}

const FONT = 'DejaVuSans';
const PAGE_W = 297, PAGE_H = 210, MARGIN = 14;
const PX_TO_MM = 25.4 / 96;

// ---------------------------------------------------------------------------------------------
// Fonts: DejaVu Sans covers Latin (with accents), Greek, Cyrillic and the symbols the app uses.
// ---------------------------------------------------------------------------------------------

let fonts: Promise<[string, string]> | null = null;

async function base64Of(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function loadFonts(): Promise<[string, string]> {
  if (!fonts) {
    const base = `${import.meta.env.BASE_URL}fonts/`;
    fonts = Promise.all([base64Of(`${base}DejaVuSans.ttf`), base64Of(`${base}DejaVuSans-Bold.ttf`)]);
    fonts.catch(() => { fonts = null; });
  }
  return fonts;
}

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

type Rgb = [number, number, number];

/** Resolves any CSS colour (custom properties included) in the light theme. */
function colorResolver(): { rgb(css: string): { rgb: Rgb; alpha: number }; dispose(): void } {
  const probe = document.createElement('div');
  probe.className = 'light-scope';
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px';
  document.body.appendChild(probe);
  return {
    rgb(css) {
      probe.style.color = '';
      probe.style.color = css;
      return parseColor(getComputedStyle(probe).color);
    },
    dispose: () => probe.remove(),
  };
}

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return { rgb: [0, 0, 0], alpha: value === 'transparent' ? 0 : 1 };
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 ? parts[3] : 1 };
}

const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// ---------------------------------------------------------------------------------------------
// SVG: copy the chart, bake the (light-theme) computed styles into attributes
// ---------------------------------------------------------------------------------------------

const SHAPES = new Set(['path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon']);

function prepareSvg(svg: SVGSVGElement): { clone: SVGSVGElement; width: number; height: number; dispose(): void } {
  const width = Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width || 800;
  const height = Number(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 400;
  const host = document.createElement('div');
  host.className = 'light-scope chart';
  host.style.cssText = `position:absolute;left:-20000px;top:0;width:${width}px`;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  host.appendChild(clone);
  document.body.appendChild(host);

  clone.querySelectorAll('.crosshair').forEach((el) => el.remove());
  // Ids from React's useId contain characters svg2pdf does not accept in url(#...).
  clone.querySelectorAll('[id]').forEach((el, i) => {
    const old = el.id, next = `e${i}`;
    el.id = next;
    clone.querySelectorAll('[clip-path]').forEach((user) => {
      if (user.getAttribute('clip-path')?.includes(old)) user.setAttribute('clip-path', `url(#${next})`);
    });
  });

  const paint = (el: Element, prop: 'fill' | 'stroke', value: string, base: number) => {
    if (!value || value === 'none' || value.startsWith('url(')) {
      el.setAttribute(prop, value && value.startsWith('url(') ? value : 'none');
      return;
    }
    const { rgb, alpha } = parseColor(value);
    if (alpha * base <= 0.001) { el.setAttribute(prop, 'none'); return; }
    el.setAttribute(prop, hex(rgb));
    if (alpha * base < 0.999) el.setAttribute(`${prop}-opacity`, String(+(alpha * base).toFixed(3)));
  };

  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'clippath' || tag === 'defs' || tag === 'title') continue;
    const cs = getComputedStyle(el);
    if (tag === 'g' || tag === 'svg') {
      if (Number(cs.opacity) < 1) el.setAttribute('opacity', cs.opacity);
    } else if (tag === 'text' || tag === 'tspan') {
      paint(el, 'fill', cs.fill, Number(cs.fillOpacity) || 1);
      el.setAttribute('font-family', FONT);
      el.setAttribute('font-size', cs.fontSize);
      el.setAttribute('font-weight', Number(cs.fontWeight) >= 600 ? 'bold' : 'normal');
      if (!el.getAttribute('text-anchor') && cs.textAnchor && cs.textAnchor !== 'start') el.setAttribute('text-anchor', cs.textAnchor);
      if (Number(cs.opacity) < 1) el.setAttribute('opacity', cs.opacity);
    } else if (SHAPES.has(tag)) {
      paint(el, 'fill', cs.fill, Number(cs.fillOpacity));
      paint(el, 'stroke', cs.stroke, Number(cs.strokeOpacity));
      if (el.getAttribute('stroke') !== 'none') {
        el.setAttribute('stroke-width', cs.strokeWidth);
        if (cs.strokeDasharray && cs.strokeDasharray !== 'none') el.setAttribute('stroke-dasharray', cs.strokeDasharray.replace(/px/g, ''));
        if (cs.strokeLinecap) el.setAttribute('stroke-linecap', cs.strokeLinecap);
        if (cs.strokeLinejoin) el.setAttribute('stroke-linejoin', cs.strokeLinejoin);
      }
      if (Number(cs.opacity) < 1) el.setAttribute('opacity', cs.opacity);
      // Invisible hit areas only add weight.
      if (el.getAttribute('fill') === 'none' && el.getAttribute('stroke') === 'none') { el.remove(); continue; }
    }
    el.removeAttribute('class');
    el.removeAttribute('style');
    el.removeAttribute('tabindex');
    el.removeAttribute('role');
  }
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  return { clone, width, height, dispose: () => host.remove() };
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export async function buildPdf(spec: PdfSpec): Promise<Blob> {
  const [regular, bold] = await loadFonts();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  doc.addFileToVFS('DejaVuSans.ttf', regular);
  doc.addFont('DejaVuSans.ttf', FONT, 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', bold);
  doc.addFont('DejaVuSans-Bold.ttf', FONT, 'bold');
  doc.setProperties({ title: spec.title, subject: spec.subtitle ?? '', creator: 'Desafío Diario' });

  const colors = colorResolver();
  try {
    const ink = colors.rgb('var(--ink)').rgb, ink2 = colors.rgb('var(--ink-2)').rgb, muted = colors.rgb('var(--muted)').rgb;
    const contentW = PAGE_W - 2 * MARGIN;
    let y = MARGIN + 2;

    doc.setFont(FONT, 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...ink);
    const titleLines = doc.splitTextToSize(spec.title, contentW) as string[];
    doc.text(titleLines, MARGIN, y + 4);
    y += 4 + titleLines.length * 6.4;

    doc.setFont(FONT, 'normal');
    if (spec.subtitle) {
      doc.setFontSize(9.5);
      doc.setTextColor(...ink2);
      const lines = (doc.splitTextToSize(spec.subtitle, contentW) as string[]).slice(0, 4);
      doc.text(lines, MARGIN, y + 1);
      y += lines.length * 4.2 + 1;
    }
    if (spec.context) {
      doc.setFontSize(8.5);
      doc.setTextColor(...muted);
      doc.text(doc.splitTextToSize(spec.context, contentW) as string[], MARGIN, y + 1);
      y += 4.6;
    }

    // Legend: keys flow left to right, wrapping as needed.
    if (spec.legend && spec.legend.length > 0) {
      y += 1.5;
      doc.setFontSize(8.5);
      let x = MARGIN;
      for (const item of spec.legend) {
        const labelW = doc.getTextWidth(item.label);
        const itemW = 7 + labelW + 6;
        if (x + itemW > MARGIN + contentW) { x = MARGIN; y += 5; }
        const { rgb, alpha } = colors.rgb(item.color);
        doc.setDrawColor(...rgb);
        doc.setFillColor(...rgb);
        const cy = y + 0.2;
        if (item.kind === 'dot') {
          doc.setGState(doc.GState({ opacity: Math.min(alpha, 0.7) }));
          doc.circle(x + 2.5, cy, 1.1, 'F');
          doc.setGState(doc.GState({ opacity: 1 }));
        } else if (item.kind === 'band' || item.kind === 'box') {
          if (item.kind === 'band') doc.setGState(doc.GState({ opacity: 0.25 }));
          doc.rect(x, cy - 1.4, 5, 2.8, 'F');
          doc.setGState(doc.GState({ opacity: 1 }));
        } else {
          doc.setLineWidth(0.6);
          if (item.kind === 'dashed') doc.setLineDashPattern([1.2, 1], 0);
          doc.line(x, cy, x + 5, cy);
          doc.setLineDashPattern([], 0);
        }
        doc.setTextColor(...ink2);
        doc.text(item.label, x + 7, cy + 1.1);
        x += itemW;
      }
      y += 5;
    }

    // Colour scale (maps).
    if (spec.scale) {
      y += 1;
      doc.setFontSize(8.5);
      doc.setTextColor(...ink2);
      doc.text(spec.scale.title, MARGIN, y + 2);
      const startX = MARGIN + doc.getTextWidth(spec.scale.title) + 5;
      const stepW = Math.min(16, (contentW - (startX - MARGIN)) / Math.max(1, spec.scale.colors.length + 1));
      spec.scale.colors.forEach((c, i) => {
        doc.setFillColor(...colors.rgb(c).rgb);
        doc.rect(startX + i * stepW, y, stepW, 2.8, 'F');
      });
      doc.setFontSize(7.5);
      doc.setTextColor(...muted);
      spec.scale.breaks.forEach((label, i) => {
        if (label) doc.text(label, startX + i * stepW, y + 6.2, { align: 'center' });
      });
      y += 9;
    }

    // The graphic fills what is left above the footer.
    y += 2;
    const footerH = 10 + (spec.notes?.length ? spec.notes.length * 4 : 0);
    const boxW = contentW, boxH = PAGE_H - MARGIN - footerH - y;
    const graphic = spec.graphic;
    if (graphic.kind === 'svg') {
      const prepared = prepareSvg(graphic.svg);
      try {
        // Fit the page, but never enlarge a small chart so much that its text balloons.
        const k = Math.min(boxW / (prepared.width * PX_TO_MM), boxH / (prepared.height * PX_TO_MM), 1.25);
        const w = prepared.width * PX_TO_MM * k, h = prepared.height * PX_TO_MM * k;
        await svg2pdf(prepared.clone, doc, { x: MARGIN, y, width: w, height: h });
        y += h;
      } finally {
        prepared.dispose();
      }
    } else if (graphic.kind === 'canvas') {
      const ratio = graphic.canvas.width / graphic.canvas.height;
      const w = Math.min(boxW, boxH * ratio), h = w / ratio;
      doc.addImage(graphic.canvas, 'PNG', MARGIN, y, w, h, undefined, 'FAST');
      doc.setDrawColor(...colors.rgb('var(--axis)').rgb);
      doc.setLineWidth(0.2);
      doc.rect(MARGIN, y, w, h, 'S');
      y += h;
    } else {
      const rows = graphic.rows;
      const rowH = Math.min(8, boxH / Math.max(1, rows.length));
      const labelW = Math.min(80, contentW * 0.35), valueW = 40;
      const trackW = contentW - labelW - valueW - 6;
      const barColor = colors.rgb('var(--seq-4)').rgb, track = colors.rgb('var(--surface-2)').rgb;
      doc.setFontSize(Math.min(9.5, rowH * 1.6));
      rows.forEach((r, i) => {
        const cy = y + i * rowH + rowH / 2;
        doc.setTextColor(...ink);
        doc.text(doc.splitTextToSize(r.label, labelW - 2)[0] as string, MARGIN, cy + 1.2);
        doc.setFillColor(...track);
        doc.roundedRect(MARGIN + labelW, cy - 1.3, trackW, 2.6, 1.3, 1.3, 'F');
        doc.setFillColor(...barColor);
        const bw = Math.max(0.5, trackW * Math.max(0, Math.min(1, r.value / graphic.max)));
        doc.roundedRect(MARGIN + labelW, cy - 1.3, bw, 2.6, 1.3, 1.3, 'F');
        doc.setTextColor(...ink);
        doc.text(r.display, MARGIN + labelW + trackW + 3, cy + 1.2);
      });
      y += rows.length * rowH;
    }

    // Notes and footer.
    let fy = PAGE_H - MARGIN - (spec.notes?.length ? spec.notes.length * 4 : 0);
    doc.setFontSize(8);
    doc.setTextColor(...ink2);
    for (const note of spec.notes ?? []) {
      doc.text(doc.splitTextToSize(note, contentW)[0] as string, MARGIN, fy);
      fy += 4;
    }
    doc.setFontSize(7);
    doc.setTextColor(...muted);
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    doc.text(`Desafío Diario · exported ${date} · Street View coverage: geo.emily.bz/coverage-dates · Boundaries: Natural Earth · Not affiliated with GeoGuessr`, MARGIN, PAGE_H - MARGIN + 4);
  } finally {
    colors.dispose();
  }
  return doc.output('blob');
}
