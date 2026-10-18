// @ts-check
/**
 * ============================================================================
 * INTERACTIVE BLACK–SCHOLES MONTE CARLO COMPONENT (SVG Vector Version)
 * ============================================================================
 *
 * Monte Carlo simulation of Black–Scholes price paths in the first quadrant.
 * Prices follow geometric Brownian motion, dS = μS dt + σS dW, simulated with
 * the exact log-normal step. Clicking the plane draws a single path from the
 * y-axis to the clicked point, then a batch of independent paths branching
 * from that point to the time horizon T.
 *
 * Each batch is simulated up front and written to the SVG once; the animation
 * only widens a clip rectangle from t = 0 to T, so every path advances through
 * time together at the same speed on any display refresh rate.
 *
 * Drift and volatility are fixed estimates from NASDAQ Composite daily closes,
 * 1971-02-05 to 2026-10-16 (FRED series NASDAQCOM).
 *
 * @author Vu Nguyen
 * @version 2.0.0
 * @license MIT
 * ============================================================================
 */

(() => {
  'use strict';

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const config = {
    width: 460,           // viewBox size; keep in sync with aspect-ratio in webstyles.css
    height: 250,
    yMax: 1,              // plane spans [0, T] × [0, yMax]
    axisColor: '#aaa',
    pathColor: '#0e0e7b',
    pathWidth: 1.2,
    pathOpacity: 0.65,
    historyOpacity: 0.9,
    paths: 8,             // Monte Carlo sample size per click
    steps: 400,           // time steps from 0 to T
    duration: 2200,       // ms to sweep from 0 to T
    idleDelay: 3000,      // ms after a batch finishes before the axes fade out
    // NASDAQ Composite, 1971-02-05 to 2026-10-16 (14,043 daily closes):
    // 9.99% annualized (geometric) return and 20.23% annualized volatility of
    // daily log returns, so μ = 0.0999 + σ²/2 ≈ 0.1204
    drift: 0.1204,        // μ, annualized
    volatility: 0.2023,   // σ, annualized
    horizon: 3,           // T, in years
    startY: 0.5,
    demoT: 0.3,           // branch time of the batch run on page load
    hintId: 'brownian-hint'   // hidden once the first user-launched batch finishes
  };

  // Plot area (viewBox units)
  const L = 22, R = config.width - 18, T = 14, B = config.height - 24;
  const toX = (/** @type {number} */ t) => L + t * (R - L);
  const toY = (/** @type {number} */ y) => B - (y / config.yMax) * (B - T);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ===========================================================================
  // SIMULATION
  // ===========================================================================

  // Standard normal sample (Box–Muller)
  function gaussian() {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }

  // Exact GBM log-step over dt = T / steps: S ← S·exp((μ − σ²/2)dt + σ√dt·Z)
  function logStep() {
    const { drift: mu, volatility: sigma, horizon, steps } = config;
    const dt = horizon / steps;
    return (mu - sigma * sigma / 2) * dt + sigma * Math.sqrt(dt) * gaussian();
  }

  /**
   * GBM path of n steps from y0; with backward = true, a path that ends at y0
   * instead (the log-price walk run backward in time)
   * @param {number} y0
   * @param {number} n
   * @param {boolean} [backward]
   */
  function simulate(y0, n, backward = false) {
    const ys = [y0];
    for (let k = 0; k < n; k++) ys.push(ys[k] * Math.exp(backward ? -logStep() : logStep()));
    return backward ? ys.reverse() : ys;
  }

  /**
   * SVG path data for values ys starting at time step k0
   * @param {number[]} ys
   * @param {number} k0
   */
  function pathData(ys, k0) {
    const parts = ys.map((y, i) => `${toX((k0 + i) / config.steps).toFixed(1)},${toY(y).toFixed(1)}`);
    return `M${parts.join('L')}`;
  }

  // ===========================================================================
  // RENDERING
  // ===========================================================================

  /**
   * @template {keyof SVGElementTagNameMap} K
   * @param {K} tag
   * @param {Record<string, string | number>} attrs
   * @returns {SVGElementTagNameMap[K]}
   */
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }

  function createAxes() {
    const g = svgEl('g', { class: 'bm-axes', stroke: config.axisColor, 'stroke-width': 0.75, fill: 'none' });
    const xe = R + 4, ye = T - 8;
    g.append(
      svgEl('path', { d: `M${L},${ye}V${B}H${xe}` }),
      svgEl('path', { d: `M${xe - 5},${B - 3}L${xe},${B}L${xe - 5},${B + 3}M${L - 3},${ye + 5}L${L},${ye}L${L + 3},${ye + 5}` }),
      // Time horizon T
      svgEl('path', { d: `M${R},${T}V${B}`, 'stroke-dasharray': '2 3', 'stroke-opacity': 0.6 }),
      // Ticks at quarters
      svgEl('path', { d: [0.25, 0.5, 0.75].map(f => `M${toX(f)},${B}v3M${L - 3},${toY(f * config.yMax)}h3`).join('') })
    );
    return g;
  }

  // ===========================================================================
  // MAIN MODULE
  // ===========================================================================

  /** @type {HTMLElement | null} */
  let root = null;
  /** @type {SVGGElement | null} */
  let layer = null;
  /** @type {SVGGElement | null} */
  let current = null;
  let frame = 0;
  let idleTimer = 0;
  let batchId = 0;

  /**
   * Draw a path from the y-axis to (t1, y1), then a batch branching from there
   * @param {number} t1
   * @param {number} y1
   * @param {boolean} user
   */
  function release(t1, y1, user) {
    if (!root || !layer) return;

    // Bring the axes back and fade out the previous batch
    clearTimeout(idleTimer);
    root.classList.remove('is-idle');
    cancelAnimationFrame(frame);
    if (current) {
      const old = current;
      old.classList.add('bm-fading');
      setTimeout(() => old.remove(), 1200);
    }

    const n1 = Math.round(t1 * config.steps);
    const clipId = `bm-reveal-${++batchId}`;
    const clipRect = svgEl('rect', { x: L - 2, y: -1e4, width: 0, height: 1e4 + B + 4 });
    const clip = svgEl('clipPath', { id: clipId });
    clip.append(clipRect);

    const paths = svgEl('g', {
      'clip-path': `url(#${clipId})`,
      fill: 'none',
      stroke: config.pathColor,
      'stroke-width': config.pathWidth,
      'stroke-opacity': config.pathOpacity,
      'stroke-linejoin': 'round'
    });
    paths.append(svgEl('path', { d: pathData(simulate(y1, n1, true), 0), 'stroke-opacity': config.historyOpacity }));
    for (let i = 0; i < config.paths; i++) {
      paths.append(svgEl('path', { d: pathData(simulate(y1, config.steps - n1), n1) }));
    }

    const batch = svgEl('g', {});
    batch.append(clip, paths);
    layer.append(batch);
    current = batch;

    // Sweep the clip from t = 0 to T
    const span = R - L + 4;
    const done = () => {
      if (user) document.getElementById(config.hintId)?.classList.add('is-hidden');
      idleTimer = window.setTimeout(() => root?.classList.add('is-idle'), config.idleDelay);
    };
    if (reducedMotion) {
      clipRect.setAttribute('width', String(span));
      done();
      return;
    }
    const start = performance.now();
    const tick = (/** @type {number} */ now) => {
      const p = Math.min(1, (now - start) / config.duration);
      clipRect.setAttribute('width', (p * span).toFixed(1));
      if (p < 1) frame = requestAnimationFrame(tick);
      else done();
    };
    frame = requestAnimationFrame(tick);
  }

  function init() {
    const container = root = document.getElementById('brownian-container');
    if (!container) return;

    const svg = svgEl('svg', { viewBox: `0 0 ${config.width} ${config.height}`, 'aria-hidden': 'true' });
    // Unclipped vertically: paths stop at T and stay positive, but may wander
    // above the plot and over the page; they never block clicks on the text
    layer = svgEl('g', { 'pointer-events': 'none' });
    svg.append(createAxes(), layer);
    container.append(svg);

    container.addEventListener('click', e => {
      const r = svg.getBoundingClientRect();
      const t = ((e.clientX - r.left) * (config.width / r.width) - L) / (R - L);
      const y = ((B - (e.clientY - r.top) * (config.height / r.height)) / (B - T)) * config.yMax;
      if (t < 1 && y > 0 && y <= config.yMax * 1.05) release(Math.max(t, 0), Math.min(y, config.yMax), true);
    });
    container.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        release(0, config.startY, true);
      }
    });

    // Demo batch shortly after load, unless the visitor has already clicked
    setTimeout(() => {
      if (!current) release(config.demoT, config.startY, false);
    }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
