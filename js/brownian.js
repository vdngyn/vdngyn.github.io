// @ts-check
/**
 * ============================================================================
 * INTERACTIVE BLACK–SCHOLES MONTE CARLO COMPONENT (SVG Vector Version)
 * ============================================================================
 *
 * Monte Carlo simulation of Black–Scholes price paths across the visible
 * window. Prices follow geometric Brownian motion, dS = μS dt + σS dW,
 * simulated with the exact log-normal step. Time runs from t = 0 at the
 * window's left edge to the horizon T at its right edge. Price is on a log
 * scale fixed to the page: the initial price S₀ (log-return 0) sits just below
 * the contact line, and the top of the page is 10·S₀.
 *
 * Clicking anywhere on the page draws a single path from S₀ at the left edge to
 * the clicked point (a Brownian bridge in log-price), then a batch of
 * independent paths branching from that point to the right edge. One path in
 * every batch suffers a black-swan crash: a single sudden log-normal jump down
 * at a random time. Batches are drawn on the page, so they scroll with it.
 *
 * Each batch is simulated up front and written to the SVG once; the animation
 * only widens a clip rectangle from t = 0 to T, so every path advances through
 * time together at the same speed on any display refresh rate.
 *
 * Drift and volatility are fixed estimates from NYSE Composite daily closes,
 * 1970-01-02 to 2026-10-16 (Yahoo Finance ^NYA).
 *
 * @author Vu Nguyen
 * @version 3.0.0
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
    axisAnchor: '.contact-line',  // log-return 0 (price S₀) sits just below this
    axisGap: 6,           // px below the anchor
    topMultiple: 10,      // the top of the page is this multiple of S₀
    axisColor: '#aaa',
    pathColor: '#0e0e7b',
    pathWidth: 1.2,
    pathOpacity: 0.65,
    historyOpacity: 0.9,
    // Black-swan crash size: log-jump ~ N(mean, sd), capped at swanMaxLog, so
    // e^-0.4 ≈ a 33% drop on average (cf. NYSE Composite: Black Monday 1987,
    // −19% in a day; Covid crash 2020, −38% peak to trough)
    swanMean: -0.4,
    swanSd: 0.1,
    swanMaxLog: -0.15,
    paths: 8,             // Monte Carlo sample size per click
    pxPerStep: 1.5,       // time resolution: one step per 1.5px of window width
    sweepSpeed: 350,      // px/s from t = 0 to T, clamped to the durations below
    minDuration: 2000,    // ms
    maxDuration: 4000,    // ms
    idleDelay: 3000,      // ms after a batch finishes before the axes fade out
    // NYSE Composite, 1970-01-02 to 2026-10-16 (14,320 daily closes):
    // 6.65% annualized (geometric) return and 16.52% annualized volatility of
    // daily log returns, so μ = 0.0665 + σ²/2 ≈ 0.0802
    drift: 0.0802,        // μ, annualized
    volatility: 0.1652,   // σ, annualized
    horizon: 3,           // T, in years
    textSelector: 'main', // the batch run on page load and by keyboard branches
                          // centered below this, and stays below it
    hintId: 'brownian-hint'   // hidden once the first user-launched batch finishes
  };

  // Clicks on these keep their normal behavior
  const INTERACTIVE = 'a, input, textarea, select, label, [contenteditable]';

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

  /**
   * GBM log-price path ln(S/S₀) of n steps of size dt from x0. Each step is
   * exact: ln S ← ln S + (μ − σ²/2)dt + σ√dt·Z, plus jumpLog on step jumpAt.
   * @param {number} x0
   * @param {number} n
   * @param {number} dt
   * @param {number} [jumpAt]
   * @param {number} [jumpLog]
   */
  function simulate(x0, n, dt, jumpAt = -1, jumpLog = 0) {
    const { drift: mu, volatility: sigma } = config;
    const m = (mu - sigma * sigma / 2) * dt, s = sigma * Math.sqrt(dt);
    const xs = [x0];
    for (let k = 0; k < n; k++) xs.push(xs[k] + m + s * gaussian() + (k === jumpAt ? jumpLog : 0));
    return xs;
  }

  /**
   * Log-price path of n steps from 0 to x1: a GBM conditioned on its endpoint,
   * i.e. a Brownian bridge (the drift drops out once the endpoint is fixed)
   * @param {number} x1
   * @param {number} n
   * @param {number} dt
   */
  function bridge(x1, n, dt) {
    if (n === 0) return [x1];
    const s = config.volatility * Math.sqrt(dt);
    const ws = [0];
    for (let k = 0; k < n; k++) ws.push(ws[k] + s * gaussian());
    return ws.map((wk, k) => wk - (k / n) * (ws[n] - x1));
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

  // Log price scale on the page: y = c − k·ln(S/S₀), with S₀ just below the
  // anchor and topMultiple·S₀ at the top of the page
  function scale() {
    const anchor = document.querySelector(config.axisAnchor);
    const c = anchor
      ? anchor.getBoundingClientRect().bottom + window.scrollY + config.axisGap
      : window.innerHeight / 2;
    return { c, k: c / Math.log(config.topMultiple) };
  }

  // y-axis down the left edge with a tick at each doubling of S₀ (a longer one
  // at S₀ itself)
  /** @param {number} page page height */
  function axesData(page) {
    const { c, k } = scale();
    const ticks = [-4, -3, -2, -1, 0, 1, 2, 3]
      .map(j => ({ y: c - k * j * Math.LN2, len: j === 0 ? 9 : 5 }))
      .filter(({ y }) => y > 0 && y < page)
      .map(({ y, len }) => `M0,${y.toFixed(1)}h${len}`).join('');
    return `M0.5,0V${page}${ticks}`;
  }

  // ===========================================================================
  // MAIN MODULE
  // ===========================================================================

  /** @type {SVGSVGElement | null} */
  let svg = null;
  /** @type {SVGPathElement | null} */
  let axes = null;
  /** @type {SVGGElement | null} */
  let layer = null;
  /** @type {SVGGElement | null} */
  let current = null;
  let frame = 0;
  let idleTimer = 0;
  let batchId = 0;

  function viewport() {
    return { w: document.documentElement.clientWidth, h: window.innerHeight };
  }

  function drawAxes() {
    axes?.setAttribute('d', axesData(document.documentElement.scrollHeight));
  }

  /**
   * Draw a path from the window's left edge to the point (x1, y1) in window
   * pixels, then a batch branching from there to the right edge
   * @param {number} x1
   * @param {number} y1
   * @param {boolean} user
   * @param {number} [ceiling] window y the paths should stay below, if possible
   */
  function release(x1, y1, user, ceiling = -Infinity) {
    if (!svg || !layer) return;
    const { w, h } = viewport();
    if (w <= 0 || h <= 0) return;

    // Bring the axes back and fade out the previous batch
    drawAxes();
    clearTimeout(idleTimer);
    svg.classList.remove('is-idle');
    cancelAnimationFrame(frame);
    if (current) {
      const old = current;
      old.classList.add('bm-fading');
      setTimeout(() => old.remove(), 1200);
    }

    // Window x ∈ [0, w] is t ∈ [0, T]; page y = c − k·x for log-price x = ln(S/S₀)
    const { scrollX: ox, scrollY: oy } = window;
    const { c, k } = scale();
    const steps = Math.max(100, Math.round(w / config.pxPerStep));
    const dt = config.horizon / steps;
    const n1 = Math.round((Math.min(Math.max(x1, 0), w) / w) * steps);
    const logPrice1 = (c - (y1 + oy)) / k;
    const pathData = (/** @type {number[]} */ xs, /** @type {number} */ k0) =>
      'M' + xs.map((x, i) => `${(ox + ((k0 + i) / steps) * w).toFixed(1)},${(c - k * x).toFixed(1)}`).join('L');

    // Resample paths that cross the ceiling, keeping the lowest-peaking try
    const cap = (c - (ceiling + oy)) / k;
    const below = (/** @type {() => number[]} */ sample) => {
      let best = sample(), peak = Math.max(...best);
      for (let i = 0; i < 40 && peak >= cap; i++) {
        const xs = sample(), p = Math.max(...xs);
        if (p < peak) [best, peak] = [xs, p];
      }
      return best;
    };

    const clipId = `bm-reveal-${++batchId}`;
    const clipRect = svgEl('rect', { x: ox - 2, y: -1e5, width: 0, height: 2e5 });
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
    paths.append(svgEl('path', { d: pathData(below(() => bridge(logPrice1, n1, dt)), 0), 'stroke-opacity': config.historyOpacity }));
    for (let i = 0; i < config.paths; i++) {
      paths.append(svgEl('path', { d: pathData(below(() => simulate(logPrice1, steps - n1, dt)), n1) }));
    }

    // Black swan: one more path, crashing once at a uniformly random time
    const swanAt = Math.floor(Math.random() * (steps - n1));
    const swanLog = Math.min(config.swanMaxLog, config.swanMean + config.swanSd * gaussian());
    paths.append(svgEl('path', { d: pathData(below(() => simulate(logPrice1, steps - n1, dt, swanAt, swanLog)), n1) }));

    const batch = svgEl('g', {});
    batch.append(clip, paths);
    layer.append(batch);
    current = batch;

    // Sweep the clip from the left edge to the right edge
    const span = w + 4;
    const duration = Math.min(config.maxDuration, Math.max(config.minDuration, (w / config.sweepSpeed) * 1000));
    const done = () => {
      if (user) document.getElementById(config.hintId)?.classList.add('is-hidden');
      idleTimer = window.setTimeout(() => svg?.classList.add('is-idle'), config.idleDelay);
    };
    if (reducedMotion) {
      clipRect.setAttribute('width', String(span));
      done();
      return;
    }
    const start = performance.now();
    const tick = (/** @type {number} */ now) => {
      const p = Math.min(1, (now - start) / duration);
      clipRect.setAttribute('width', (p * span).toFixed(1));
      if (p < 1) frame = requestAnimationFrame(tick);
      else done();
    };
    frame = requestAnimationFrame(tick);
  }

  // Page load and keyboard: branch centered in the space below the main text,
  // keeping the paths out of the text (leaves at least 15% of the window free)
  function releaseDefault(/** @type {boolean} */ user) {
    const { w, h } = viewport();
    const textBottom = document.querySelector(config.textSelector)?.getBoundingClientRect().bottom ?? 0;
    const top = Math.min(Math.max(textBottom, 0), 0.85 * h);
    release(w / 2, (top + h) / 2, user, top + 4);
  }

  function init() {
    // Overlay on the page (not the window); never intercepts clicks
    svg = svgEl('svg', { id: 'brownian-overlay', 'aria-hidden': 'true' });
    axes = svgEl('path', { class: 'bm-axes', fill: 'none', stroke: config.axisColor, 'stroke-width': 0.75 });
    layer = svgEl('g', {});
    svg.append(axes, layer);
    document.body.append(svg);

    drawAxes();
    window.addEventListener('resize', drawAxes);

    document.addEventListener('click', e => {
      if (!(e.target instanceof Element) || e.target.closest(INTERACTIVE)) return;
      if (String(window.getSelection() ?? '')) return;  // finishing a text selection
      if (e.detail === 0) releaseDefault(true);         // keyboard activation of the hint button
      else release(e.clientX, e.clientY, true);
    });

    // Demo batch shortly after load, unless the visitor has already clicked
    setTimeout(() => {
      if (!current) releaseDefault(false);
    }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
