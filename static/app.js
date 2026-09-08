"use strict";

document.documentElement.classList.toggle(
  "standalone",
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
);

const RESOURCE_POLL_INTERVAL_MS = 5_000;
const SESSION_POLL_INTERVAL_MS = 15_000;
const HISTORY_WINDOW_MS = 5 * 60_000;
const MAX_POINTS = Math.ceil(HISTORY_WINDOW_MS / RESOURCE_POLL_INTERVAL_MS) + 1;
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  chartMinutes: 5,
  cpu: [],
  memory: [],
  network: [],
  sessions: [],
  nodes: [],
  resourceTimer: null,
  sessionTimer: null,
  resourceInFlight: false,
  sessionInFlight: false,
  resourceOK: null,
  sessionsOK: null,
  plexOK: null,
  nodesOK: null,
  lastSuccessAt: null,
  view: "system",
  viewScroll: { system: 0, infrastructure: 0, playing: 0, settings: 0 },
};

const chartViews = new Map();

const elements = {
  connection: document.querySelector("#connection-status"),
  updatedLabel: document.querySelector("#updated-label"),
  refreshButton: document.querySelector("#refresh-button"),
  cpuValue: document.querySelector("#cpu-value"),
  cpuDetail: document.querySelector("#cpu-detail"),
  ramValue: document.querySelector("#ram-value"),
  ramDetail: document.querySelector("#ram-detail"),
  cpuChart: document.querySelector("#cpu-chart"),
  ramChart: document.querySelector("#ram-chart"),
  networkChart: document.querySelector("#network-chart"),
  downloadValue: document.querySelector("#download-value"),
  uploadValue: document.querySelector("#upload-value"),
  networkDetail: document.querySelector("#network-detail"),
  networkScaleMax: document.querySelector("#network-scale-max"),
  networkScaleMid: document.querySelector("#network-scale-mid"),
  cpuRangeStart: document.querySelector("#cpu-range-start"),
  ramRangeStart: document.querySelector("#ram-range-start"),
  networkRangeStart: document.querySelector("#network-range-start"),
  diskList: document.querySelector("#disk-list"),
  nodes: document.querySelector("#nodes"),
  nodeSummary: document.querySelector("#node-summary"),
  resourceMessage: document.querySelector("#resource-message"),
  sessions: document.querySelector("#sessions"),
  sessionCount: document.querySelector("#session-count"),
  sessionMessage: document.querySelector("#session-message"),
  playingBadge: document.querySelector("#playing-badge"),
  nodesBadge: document.querySelector("#nodes-badge"),
  viewSections: document.querySelectorAll("[data-view]"),
  tabButtons: document.querySelectorAll("[data-tab]"),
};

function setConnection(kind, label) {
  if (!elements.connection) return;
  const live = kind === "live";
  elements.connection.className = `live-indicator status-${live ? "live" : "offline"}`;
  elements.connection.setAttribute("aria-label", live ? "Live" : "Disconnected");
}

function setView(view) {
  if (!Object.hasOwn(state.viewScroll, view)) return;
  state.viewScroll[state.view] = window.scrollY;
  state.view = view;
  for (const section of elements.viewSections) section.hidden = section.dataset.view !== view;
  window.dispatchEvent(new Event("monitor-view-change"));
  for (const button of elements.tabButtons) {
    const selected = button.dataset.tab === view;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  window.requestAnimationFrame(() => {
    window.scrollTo(0, state.viewScroll[view]);
    redrawCharts();
  });
}

function nextPaint() {
  return new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
}

function redrawCharts() {
  renderChart(elements.cpuChart, state.cpu, "#ee8b9d", elements.cpuRangeStart);
  renderNetworkChart();
  renderChart(elements.ramChart, state.memory, "#4bc7b1", elements.ramRangeStart);
}

function formatUpdatedTime(date) {
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)}`;
}

function formatMegabytes(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GiB`;
  return `${Math.round(value)} MiB`;
}

function validPercent(value) {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function appendSample(series, sample) {
  const cutoff = sample.t - HISTORY_WINDOW_MS;
  const previous = series.at(-1);
  if (previous && previous.t === sample.t) {
    series[series.length - 1] = sample;
  } else {
    series.push(sample);
  }
  while (series.length > MAX_POINTS || (series[0] && series[0].t < cutoff)) {
    series.shift();
  }
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function seriesPaths(points, now, start, maximum = 100, valueKey = "value") {
  const paths = [];
  let current = [];
  const duration = Math.max(1, now - start);

  for (const point of points) {
    const value = point[valueKey];
    if (point.t < start || point.t > now || value === null) {
      if (current.length) paths.push(current);
      current = [];
      continue;
    }
    current.push({
      x: ((point.t - start) / duration) * 600,
      y: 170 - (value / maximum) * 170,
    });
  }
  if (current.length) paths.push(current);
  return paths;
}

function bandwidthCeiling(points) {
  const peak = Math.max(0, ...points.flatMap((point) => [point.download || 0, point.upload || 0]));
  if (peak <= 0) return 1_000_000;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalized = peak / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatBandwidth(bitsPerSecond, compact = false) {
  const value = Number(bitsPerSecond);
  if (!Number.isFinite(value)) return "--";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(compact ? 1 : 2)} Gbps`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(compact ? 0 : 1)} Mbps`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(compact ? 0 : 1)} kbps`;
  return `${Math.round(value)} bps`;
}

function smoothPath(points) {
  if (points.length < 3) {
    return points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" ");
  }

  const commands = [`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const following = points[Math.min(points.length - 1, index + 2)];
    const control1X = current.x + (next.x - previous.x) / 6;
    const control1Y = Math.min(170, Math.max(0, current.y + (next.y - previous.y) / 6));
    const control2X = next.x - (following.x - current.x) / 6;
    const control2Y = Math.min(170, Math.max(0, next.y - (following.y - current.y) / 6));
    commands.push(
      `C ${control1X.toFixed(1)} ${control1Y.toFixed(1)}, ${control2X.toFixed(1)} ${control2Y.toFixed(1)}, ${next.x.toFixed(1)} ${next.y.toFixed(1)}`,
    );
  }
  return commands.join(" ");
}

function historyLabel(duration) {
  if (duration >= HISTORY_WINDOW_MS) return "5m ago";
  if (duration < 60_000) return `${Math.max(1, Math.round(duration / 1000))}s ago`;
  return `${Math.max(1, Math.round(duration / 60_000))}m ago`;
}

function renderChart(svg, points, color, rangeLabel) {
  svg.setAttribute("aria-label", `${svg === elements.cpuChart ? "CPU" : "Memory"} usage over the last ${state.chartMinutes} minutes`);
  svg.replaceChildren();
  svg.append(
    svgElement("rect", { x: 0, y: 0, width: 600, height: 17, class: "chart-threshold-danger" }),
    svgElement("rect", { x: 0, y: 17, width: 600, height: 17, class: "chart-threshold-warning" }),
  );
  if (svg === elements.cpuChart) {
    svg.append(svgElement("rect", { x: 0, y: 153, width: 600, height: 17, class: "chart-threshold-low" }));
  }
  for (const value of [0, 25, 50, 75, 100]) {
    const y = 170 - (value / 100) * 170;
    svg.append(svgElement("line", { x1: 0, y1: y, x2: 600, y2: y, class: "chart-grid" }));
  }

  const now = Date.now();
  const firstSample = points.find((point) => point.t >= now - HISTORY_WINDOW_MS);
  const collectedDuration = firstSample ? Math.min(state.chartMinutes * 60_000, Math.max(0, now - firstSample.t)) : 0;
  const displayDuration = Math.max(RESOURCE_POLL_INTERVAL_MS, collectedDuration);
  const start = now - displayDuration;
  const paths = seriesPaths(points, now, start);
  for (const segment of paths) {
    svg.append(svgElement("path", { d: smoothPath(segment), class: "chart-line", stroke: color }));
  }

  const latest = paths.at(-1)?.at(-1);
  if (latest) {
    if (paths.length === 1 && paths[0].length === 1) {
      svg.append(
        svgElement("line", {
          x1: 0,
          y1: latest.y,
          x2: latest.x,
          y2: latest.y,
          class: "chart-provisional",
          stroke: color,
        }),
      );
    }
    svg.append(
      svgElement("ellipse", {
        cx: latest.x,
        cy: latest.y,
        rx: circularMarkerRadiusX(svg, 4),
        ry: 4,
        class: "chart-point",
        fill: color,
      }),
    );
  }
  svg.append(svgElement("rect", { x: 0, y: 0, width: 600, height: 170, class: "chart-hit-area" }));
  rangeLabel.textContent = firstSample ? historyLabel(collectedDuration) : "Starting now";
  const view = chartViews.get(svg);
  if (view) {
    view.start = start;
    view.now = now;
    view.points = points.filter((point) => point.t >= start && point.t <= now && point.value !== null);
    if (view.scrubbing && view.clientX !== null) updateScrub(svg, view.clientX);
  }
}

function renderNetworkChart() {
  const svg = elements.networkChart;
  svg.setAttribute("aria-label", `System download and upload bandwidth over the last ${state.chartMinutes} minutes`);
  svg.replaceChildren();
  for (const value of [0, 25, 50, 75, 100]) {
    const y = 170 - (value / 100) * 170;
    svg.append(svgElement("line", { x1: 0, y1: y, x2: 600, y2: y, class: "chart-grid" }));
  }

  const now = Date.now();
  const firstSample = state.network.find((point) => point.t >= now - HISTORY_WINDOW_MS);
  const collectedDuration = firstSample ? Math.min(state.chartMinutes * 60_000, Math.max(0, now - firstSample.t)) : 0;
  const displayDuration = Math.max(RESOURCE_POLL_INTERVAL_MS, collectedDuration);
  const start = now - displayDuration;
  const visible = state.network.filter((point) => point.t >= start && point.t <= now);
  const maximum = bandwidthCeiling(visible);

  for (const [key, color] of [["download", "#79b8ed"], ["upload", "#e6bd72"]]) {
    const paths = seriesPaths(state.network, now, start, maximum, key);
    for (const segment of paths) {
      svg.append(svgElement("path", { d: smoothPath(segment), class: "chart-line", stroke: color }));
    }
    const latest = paths.at(-1)?.at(-1);
    if (latest) {
      svg.append(svgElement("ellipse", {
        cx: latest.x,
        cy: latest.y,
        rx: circularMarkerRadiusX(svg, 4),
        ry: 4,
        class: "chart-point",
        fill: color,
      }));
    }
  }

  svg.append(svgElement("rect", { x: 0, y: 0, width: 600, height: 170, class: "chart-hit-area" }));
  elements.networkScaleMax.textContent = formatBandwidth(maximum, true);
  elements.networkScaleMid.textContent = formatBandwidth(maximum / 2, true);
  elements.networkRangeStart.textContent = firstSample ? historyLabel(collectedDuration) : "Starting now";

  const view = chartViews.get(svg);
  if (view) {
    view.start = start;
    view.now = now;
    view.maximum = maximum;
    view.points = visible.filter((point) => point.download !== null || point.upload !== null);
    if (view.scrubbing && view.clientX !== null) updateScrub(svg, view.clientX);
  }
}

function formatSampleTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function circularMarkerRadiusX(svg, radius) {
  const bounds = svg.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return radius;
  return radius * (bounds.height / 170) / (bounds.width / 600);
}

function updateScrub(svg, clientX) {
  const view = chartViews.get(svg);
  if (!view || view.points.length === 0) return;

  const bounds = svg.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  const targetTime = view.start + ratio * (view.now - view.start);
  const sample = view.points.reduce((nearest, point) => (
    Math.abs(point.t - targetTime) < Math.abs(nearest.t - targetTime) ? point : nearest
  ));
  const x = ((sample.t - view.start) / Math.max(1, view.now - view.start)) * 600;

  if (view.kind === "network") {
    svg.querySelectorAll(".chart-crosshair, .chart-scrub-point").forEach((element) => element.remove());
    svg.append(svgElement("line", { x1: x, y1: 0, x2: x, y2: 170, class: "chart-crosshair" }));
    for (const [key, color] of [["download", "#79b8ed"], ["upload", "#e6bd72"]]) {
      if (sample[key] === null) continue;
      const y = 170 - (sample[key] / view.maximum) * 170;
      svg.append(svgElement("ellipse", {
        cx: x,
        cy: y,
        rx: circularMarkerRadiusX(svg, 6),
        ry: 6,
        class: "chart-scrub-point",
        style: `fill: ${color}`,
      }));
    }
    elements.downloadValue.textContent = formatBandwidth(sample.download);
    elements.uploadValue.textContent = formatBandwidth(sample.upload);
    elements.networkDetail.textContent = `At ${formatSampleTime(sample.t)}`;
    svg.classList.add("is-scrubbing");
    return;
  }

  const y = 170 - (sample.value / 100) * 170;

  svg.querySelectorAll(".chart-crosshair, .chart-scrub-point").forEach((element) => element.remove());
  svg.append(
    svgElement("line", { x1: x, y1: 0, x2: x, y2: 170, class: "chart-crosshair" }),
    svgElement("ellipse", {
      cx: x,
      cy: y,
      rx: circularMarkerRadiusX(svg, 6),
      ry: 6,
      class: "chart-scrub-point",
    }),
  );
  view.valueElement.textContent = `${Math.round(sample.value)}%`;
  view.detailElement.textContent = `At ${formatSampleTime(sample.t)}`;
  svg.classList.add("is-scrubbing");
}

function stopScrub(svg) {
  const view = chartViews.get(svg);
  if (!view) return;
  view.scrubbing = false;
  view.clientX = null;
  svg.classList.remove("is-scrubbing");
  svg.querySelectorAll(".chart-crosshair, .chart-scrub-point").forEach((element) => element.remove());
  if (view.kind === "network") {
    elements.downloadValue.textContent = view.liveDownload;
    elements.uploadValue.textContent = view.liveUpload;
    elements.networkDetail.textContent = view.liveDetail;
    return;
  }
  view.valueElement.textContent = view.liveValue;
  view.detailElement.textContent = view.liveDetail;
}

function setupNetworkChartScrubbing() {
  const svg = elements.networkChart;
  const view = {
    kind: "network",
    points: [],
    maximum: 1_000_000,
    start: Date.now() - RESOURCE_POLL_INTERVAL_MS,
    now: Date.now(),
    scrubbing: false,
    clientX: null,
    liveDownload: "--",
    liveUpload: "--",
    liveDetail: "System bandwidth",
  };
  chartViews.set(svg, view);

  const beginOrMove = (event) => {
    if (event.pointerType !== "mouse" && !view.scrubbing) return;
    view.scrubbing = true;
    view.clientX = event.clientX;
    updateScrub(svg, event.clientX);
  };
  svg.addEventListener("pointerenter", beginOrMove);
  svg.addEventListener("pointermove", beginOrMove);
  svg.addEventListener("pointerdown", (event) => {
    view.scrubbing = true;
    view.clientX = event.clientX;
    svg.setPointerCapture(event.pointerId);
    updateScrub(svg, event.clientX);
  });
  svg.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") stopScrub(svg);
  });
  svg.addEventListener("pointerup", () => stopScrub(svg));
  svg.addEventListener("pointercancel", () => stopScrub(svg));
}

function setLiveNetworkReadout(download, upload, detail) {
  const view = chartViews.get(elements.networkChart);
  if (!view) return;
  view.liveDownload = download;
  view.liveUpload = upload;
  view.liveDetail = detail;
  if (!view.scrubbing) {
    elements.downloadValue.textContent = download;
    elements.uploadValue.textContent = upload;
    elements.networkDetail.textContent = detail;
  }
}

function setupChartScrubbing(svg, valueElement, detailElement) {
  const view = {
    points: [],
    start: Date.now() - RESOURCE_POLL_INTERVAL_MS,
    now: Date.now(),
    scrubbing: false,
    clientX: null,
    valueElement,
    detailElement,
    liveValue: valueElement.textContent,
    liveDetail: detailElement.textContent,
  };
  chartViews.set(svg, view);

  const beginOrMove = (event) => {
    if (event.pointerType !== "mouse" && !view.scrubbing) return;
    view.scrubbing = true;
    view.clientX = event.clientX;
    updateScrub(svg, event.clientX);
  };
  svg.addEventListener("pointerenter", beginOrMove);
  svg.addEventListener("pointermove", beginOrMove);
  svg.addEventListener("pointerdown", (event) => {
    view.scrubbing = true;
    view.clientX = event.clientX;
    svg.setPointerCapture(event.pointerId);
    updateScrub(svg, event.clientX);
  });
  svg.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") stopScrub(svg);
  });
  svg.addEventListener("pointerup", () => stopScrub(svg));
  svg.addEventListener("pointercancel", () => stopScrub(svg));
}

function setLiveReadout(svg, value, detail) {
  const view = chartViews.get(svg);
  if (!view) return;
  view.liveValue = value;
  view.liveDetail = detail;
  if (!view.scrubbing) {
    view.valueElement.textContent = value;
    view.detailElement.textContent = detail;
  }
}

function showDisks(disks) {
  elements.diskList.replaceChildren();
  const available = Array.isArray(disks)
    ? disks.filter((disk) => !disk.unavailable && Number(disk.total_gb) > 0)
    : [];
  if (available.length === 0) {
    elements.diskList.append(elementWithClass("p", "disk-empty", "Disk metrics unavailable"));
    return;
  }

  for (const disk of available) {
    const used = Number(disk.used_gb);
    const total = Number(disk.total_gb);
    const percent = validPercent((used / total) * 100);
    const row = elementWithClass("div", "disk-row");
    const summary = elementWithClass("div", "disk-summary");
    const label = disk.scratch ? "System disk" : humanize(disk.role || "Media disk");
    const name = elementWithClass("span", "disk-name", label);
    if (disk.path) name.title = disk.path;
    summary.append(
      name,
      elementWithClass("span", "disk-value", `${Math.round(percent)}% · ${used.toFixed(1)} of ${total.toFixed(1)} GiB`),
    );
    const track = elementWithClass("div", "disk-track");
    const fill = elementWithClass("div", `disk-fill${percent >= 90 ? " disk-danger" : percent >= 80 ? " disk-warning" : ""}`);
    fill.style.width = `${percent}%`;
    track.append(fill);
    row.append(summary, track);
    elements.diskList.append(row);
  }
}

function showResourceSample(payload) {
  const system = payload?.system;
  if (!payload?.available || !system) {
    elements.resourceMessage.hidden = false;
    elements.resourceMessage.textContent = "Resource sampling is unavailable on this Silo host.";
    elements.cpuDetail.textContent = "Unavailable";
    elements.ramDetail.textContent = "Unavailable";
    return;
  }

  elements.resourceMessage.hidden = true;
  const cpu = validPercent(Number(system.cpu_pct));
  const used = Number(system.mem_used_mb);
  const total = Number(system.mem_total_mb);
  const memory = total > 0 ? validPercent((used / total) * 100) : null;
  const sampledAt = Date.parse(payload.sampled_at) || Date.now();

  appendSample(state.cpu, { t: sampledAt, value: cpu });
  appendSample(state.memory, { t: sampledAt, value: memory });

  const cpuValue = cpu === null ? "--%" : `${Math.round(cpu)}%`;
  const cpuDetail = Number.isFinite(system.cores)
    ? `${system.cores} cores · load ${Number(system.load1 || 0).toFixed(2)}`
    : "Aggregate usage";
  const ramValue = memory === null ? "--%" : `${Math.round(memory)}%`;
  const ramDetail = total > 0
    ? `${formatMegabytes(used)} of ${formatMegabytes(total)}`
    : "Capacity unavailable";
  setLiveReadout(elements.cpuChart, cpuValue, cpuDetail);
  setLiveReadout(elements.ramChart, ramValue, ramDetail);
  showDisks(system.disks);

  renderChart(elements.cpuChart, state.cpu, "#ee8b9d", elements.cpuRangeStart);
  renderChart(elements.ramChart, state.memory, "#4bc7b1", elements.ramRangeStart);
}

function recordResourceGap() {
  const now = Date.now();
  appendSample(state.cpu, { t: now, value: null });
  appendSample(state.memory, { t: now, value: null });
  renderChart(elements.cpuChart, state.cpu, "#ee8b9d", elements.cpuRangeStart);
  renderChart(elements.ramChart, state.memory, "#4bc7b1", elements.ramRangeStart);
}

function elementWithClass(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function humanize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const knownLabels = {
    audio: "Audio Transcode",
    direct: "Direct Play",
    direct_play: "Direct Play",
    hls: "HLS",
    remux: "Remux",
    transcode: "Transcode",
    unknown: "Unknown",
  };
  if (knownLabels[normalized]) return knownLabels[normalized];
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sessionTitle(session) {
  const isEpisode = session.series_name && session.season_number != null && session.episode_number != null;
  if (isEpisode) {
    return session.episode_name || `S${session.season_number}E${session.episode_number}`;
  }
  return session.media_title || "Unknown title";
}

function sessionSubtitle(session) {
  if (session.subtitle) return session.subtitle;
  if (session.series_name && session.season_number != null && session.episode_number != null) {
    return `S${session.season_number} · E${session.episode_number} — ${session.series_name}`;
  }
  return humanize(session.media_type || "Media");
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Live";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function resolutionLabel(value) {
  const resolution = String(value || "").trim().toLowerCase();
  if (!resolution || resolution === "unknown") return "";
  if (["4k", "uhd", "2160", "2160p"].includes(resolution)) return "4K";
  const dimensions = resolution.match(/^(\d+)\s*x\s*(\d+)$/);
  if (dimensions) {
    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    if (width >= 3800 || height >= 2160) return "4K";
    if (width >= 1900 || height >= 1080) return "1080p";
    if (width >= 1280 || height >= 720) return "720p";
    if (height >= 576) return "576p";
    if (height > 0) return height > 480 || width >= 640 ? "480p" : `${height}p`;
    return "";
  }
  if (/^\d+$/.test(resolution)) return `${resolution}p`;
  return /^\d+[pi]$/.test(resolution) ? resolution : "";
}

function audioLabel(codec, profile) {
  const normalized = String(codec || "").trim().toLowerCase();
  if (!normalized || ["unknown", "copy", "none"].includes(normalized)) return "";
  const detail = String(profile || "").trim().toLowerCase();
  if (["dts", "dca"].includes(normalized)) {
    if (["ma", "dts-hd ma", "dts-hd master audio"].includes(detail)) return "DTS-HD MA";
    if (["hra", "dts-hd hra", "dts-hd high resolution audio"].includes(detail)) return "DTS-HD HRA";
    return "DTS";
  }
  return ({ ac3: "DD", eac3: "DD+", "e-ac-3": "DD+", "ac-3": "DD", dtshd: "DTS-HD", dts_hd: "DTS-HD", dts_hd_ma: "DTS-HD MA", truehd: "TrueHD", aac: "AAC", flac: "FLAC", opus: "Opus", mp3: "MP3" })[normalized] || normalized.toUpperCase();
}

function playbackDetails(session) {
  const sourceResolution = resolutionLabel(session.source_video_resolution);
  const targetResolution = resolutionLabel(session.target_resolution);
  const sourceAudio = audioLabel(session.source_audio_codec, session.source_audio_profile);
  const targetAudio = audioLabel(session.target_audio_codec);
  const changed = (source, target) => source && target && source !== target ? `${source} → ${target}` : target || source;
  const toneMap = session.source !== "plex"
    ? ({ software: "SW Tone Map", hardware: "HW Tone Map" })[session.tone_map_mode] || ""
    : "";
  return { resolution: changed(sourceResolution, targetResolution), audio: changed(sourceAudio, targetAudio), toneMap };
}

function addTag(container, text, className = "") {
  if (!text) return;
  const tag = elementWithClass("span", `tag ${className}`.trim(), text);
  tag.title = text;
  container.append(tag);
}

function playbackIcon(className) {
  const wrapper = elementWithClass("span", className);
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.append(elementWithClass("span", "ui-icon icon-playing"));
  return wrapper;
}

function createSessionCard(session) {
  const card = elementWithClass("article", `session-card${session.is_paused ? " paused" : ""}`);
  const poster = elementWithClass("div", "poster");
  if (session.poster_url) {
    const image = document.createElement("img");
    image.src = session.poster_url;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      image.remove();
      poster.prepend(playbackIcon("poster-fallback"));
    }, { once: true });
    poster.append(image);
  } else {
    poster.append(playbackIcon("poster-fallback"));
  }
  if (session.is_paused) {
    poster.append(elementWithClass("span", "pause-overlay", "Ⅱ"));
  }

  const copy = elementWithClass("div", "session-copy");
  copy.append(
    elementWithClass("div", "session-title", sessionTitle(session)),
    elementWithClass("div", "session-subtitle", sessionSubtitle(session)),
  );

  const tags = elementWithClass("div", "session-tags");
  addTag(tags, session.source === "plex" ? "Plex" : "Silo", `session-source source-${session.source === "plex" ? "plex" : "silo"}`);
  const method = String(session.effective_play_method || session.play_method || "unknown").toLowerCase();
  addTag(tags, humanize(method), method.includes("transcode") || method === "audio" ? "tag-transcode" : "tag-method");
  const details = playbackDetails(session);
  addTag(tags, details.resolution, "session-resolution");
  addTag(tags, details.toneMap, "session-tonemap");
  addTag(tags, details.audio, "session-audio");
  addTag(tags, session.client_label || session.client_name, "session-client");
  addTag(tags, session.node_display_name || session.reporting_node, "session-node");
  addTag(tags, session.profile_name || session.profile_id, "session-profile");
  copy.append(tags);

  const duration = Number(session.file_duration);
  const position = Number(session.position_seconds);
  if (duration > 0 && position >= 0) {
    const track = elementWithClass("div", "progress-track");
    const fill = elementWithClass("div", "progress-fill");
    fill.style.width = `${Math.min(100, Math.max(0, (position / duration) * 100))}%`;
    track.append(fill);
    copy.append(track);
  }

  const username = session.username || `User ${session.user_id || ""}`.trim();
  const footer = elementWithClass("div", "session-footer");
  footer.append(
    elementWithClass("span", "avatar", username.charAt(0).toUpperCase() || "?"),
    elementWithClass("span", "session-user", username),
    elementWithClass("span", "session-time", session.source === "plex"
      ? humanize(session.playback_state || (session.is_paused ? "paused" : "playing"))
      : `Started ${relativeTime(session.started_at)}`),
  );
  copy.append(footer);
  card.append(poster, copy);
  return card;
}

function showSessions(payload) {
  const sessions = Array.isArray(payload) ? payload : [];
  state.sessions = sessions;
  elements.sessionCount.textContent = `${sessions.length} ${sessions.length === 1 ? "stream" : "streams"}`;
  elements.playingBadge.textContent = sessions.length > 99 ? "99+" : String(sessions.length);
  elements.playingBadge.setAttribute("aria-label", `${sessions.length} active ${sessions.length === 1 ? "stream" : "streams"}`);
  elements.playingBadge.hidden = sessions.length === 0;
  elements.sessions.replaceChildren();
  if (sessions.length === 0) {
    const empty = elementWithClass("div", "empty-state");
    empty.append(
      playbackIcon("empty-icon"),
      elementWithClass("strong", "", state.sessionsOK === false || state.plexOK === false ? "Playback status incomplete" : "Nothing playing right now"),
      elementWithClass("span", "", state.sessionsOK === false || state.plexOK === false ? "Waiting for playback sources to reconnect." : "Active sessions will appear automatically."),
    );
    elements.sessions.append(empty);
    renderNodes();
    return;
  }
  for (const session of sessions) {
    elements.sessions.append(createSessionCard(session));
  }
  renderNodes();
}

function formatMbps(kbps) {
  const value = Number(kbps);
  if (!Number.isFinite(value) || value <= 0) return "0 Mbps";
  if (value < 1000) return `${Math.round(value)} kbps`;
  return `${(value / 1000).toFixed(1)} Mbps`;
}

function nodeRouteCount(node) {
  const key = node.type === "proxy" ? "routing_egress_node_id" : "routing_execution_node_id";
  return state.sessions.filter((session) => session.source !== "plex" && Number(session[key]) === Number(node.id)).length;
}

function nodeResourceSummary(node) {
  const system = node.last_stats?.system;
  const values = [];
  if (Number.isFinite(Number(system?.cpu_pct))) values.push(`CPU ${Math.round(Number(system.cpu_pct))}%`);
  const used = Number(system?.mem_used_mb);
  const total = Number(system?.mem_total_mb);
  if (total > 0) values.push(`RAM ${Math.round((used / total) * 100)}%`);
  const gpu = Array.isArray(node.last_stats?.gpu) ? node.last_stats.gpu : [];
  const gpuBusy = gpu
    .flatMap((device) => [device.total_busy_pct, device.video_busy_pct, device.render_busy_pct])
    .map(Number)
    .filter(Number.isFinite);
  if (gpuBusy.length > 0) values.push(`GPU ${Math.round(Math.max(...gpuBusy))}%`);
  return values.join(" · ") || "No resource sample";
}

function nodeStatus(node) {
  if (!node.enabled) return { label: "Disabled", className: "node-disabled" };
  if (!node.healthy) return { label: "Unhealthy", className: "node-unhealthy" };
  return { label: "Healthy", className: "node-healthy" };
}

function createNodeCard(node) {
  const card = elementWithClass("article", "node-card");
  const header = elementWithClass("div", "node-header");
  const identity = elementWithClass("div", "node-identity");
  identity.append(
    elementWithClass("strong", "node-name", node.name || `Node ${node.id}`),
    elementWithClass("span", "node-role", humanize(node.type || "Node")),
  );
  const status = nodeStatus(node);
  const statusElement = elementWithClass("span", `node-status ${status.className}`, status.label);
  header.append(identity, statusElement);

  const routed = nodeRouteCount(node);
  const route = elementWithClass("div", "node-route");
  route.append(
    elementWithClass("strong", "node-route-value", String(routed)),
    elementWithClass(
      "span",
      "node-route-label",
      `${routed === 1 ? "stream" : "streams"} ${node.type === "proxy" ? "egressing" : "executing"}`,
    ),
  );

  const jobs = Number(node.active_jobs) || 0;
  const maxJobs = Number(node.max_jobs) > 0 ? Number(node.max_jobs) : null;
  const stats = elementWithClass("div", "node-stats");
  const statValues = [
    ["Jobs", maxJobs ? `${jobs}/${maxJobs}` : String(jobs)],
    ["Egress", formatMbps(node.egress_kbps)],
    ["Checked", relativeTime(node.last_health_check)],
  ];
  if (node.type === "transcode") {
    statValues.push(["Accelerator", String(node.capabilities?.resolved || "none").toUpperCase()]);
  }
  for (const [label, value] of statValues) {
    const stat = elementWithClass("div", `node-stat node-stat-${label.toLowerCase()}`);
    stat.append(elementWithClass("span", "node-stat-label", label), elementWithClass("strong", "", value));
    stats.append(stat);
  }

  card.append(header, route, stats, elementWithClass("div", "node-resources", nodeResourceSummary(node)));
  return card;
}

function renderNodes() {
  const nodes = [...state.nodes].sort(
    (left, right) => String(left.type).localeCompare(String(right.type)) || String(left.name).localeCompare(String(right.name)),
  );
  const enabled = nodes.filter((node) => node.enabled);
  const healthy = enabled.filter((node) => node.healthy).length;
  const transcodeJobs = nodes
    .filter((node) => String(node.type).toLowerCase() === "transcode")
    .reduce((total, node) => total + Math.max(0, Number(node.active_jobs) || 0), 0);
  elements.nodesBadge.textContent = transcodeJobs > 99 ? "99+" : String(transcodeJobs);
  elements.nodesBadge.setAttribute(
    "aria-label",
    `${transcodeJobs} active transcode ${transcodeJobs === 1 ? "job" : "jobs"}`,
  );
  elements.nodesBadge.hidden = transcodeJobs === 0;
  elements.nodeSummary.textContent = nodes.length === 0
    ? "No remote nodes"
    : `${healthy}/${enabled.length} healthy`;
  elements.nodes.replaceChildren();
  if (nodes.length === 0) {
    const empty = elementWithClass("div", "empty-state");
    empty.append(
      elementWithClass("strong", "", "No remote stream nodes"),
      elementWithClass("span", "", "Playback work is running on the Silo API host."),
    );
    elements.nodes.append(empty);
    return;
  }
  for (const node of nodes) elements.nodes.append(createNodeCard(node));
}

function showNodes(payload) {
  state.nodes = Array.isArray(payload) ? payload : [];
  renderNodes();
}

async function fetchJSON(path) {
  const response = await fetch(path, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function loadResourceHistory() {
  const samples = await fetchJSON("/api/history");
  if (!Array.isArray(samples)) return;
  const cpu = [];
  const memory = [];
  const network = [];
  const optionalNumber = (value) => value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(value);
  for (const sample of samples) {
    const timestamp = Number(sample.t);
    if (!Number.isFinite(timestamp)) continue;
    appendSample(cpu, {
      t: timestamp,
      value: optionalNumber(sample.cpu_pct) === null ? null : validPercent(Number(sample.cpu_pct)),
    });
    appendSample(memory, {
      t: timestamp,
      value: optionalNumber(sample.mem_pct) === null ? null : validPercent(Number(sample.mem_pct)),
    });
    appendSample(network, {
      t: timestamp,
      download: optionalNumber(sample.net_rx_bps),
      upload: optionalNumber(sample.net_tx_bps),
    });
  }
  state.cpu = cpu;
  state.memory = memory;
  state.network = network;
  const latestNetwork = network.findLast((sample) => sample.download !== null || sample.upload !== null);
  if (latestNetwork) {
    setLiveNetworkReadout(
      formatBandwidth(latestNetwork.download),
      formatBandwidth(latestNetwork.upload),
      "System bandwidth",
    );
  }
  redrawCharts();
}

function noteSuccess() {
  state.lastSuccessAt = new Date();
  if (elements.updatedLabel) elements.updatedLabel.textContent = formatUpdatedTime(state.lastSuccessAt);
}

function updateConnection() {
  const statuses = [state.resourceOK, state.sessionsOK, state.nodesOK];
  if (state.plexOK !== null) statuses.push(state.plexOK);
  if (statuses.every((status) => status === true)) setConnection("live", "Live");
  else if (statuses.every((status) => status === false)) setConnection("offline", "Disconnected");
  else if (statuses.some((status) => status === false)) setConnection("degraded", "Partial");
  else setConnection("waiting", "Connecting");
}

function showProcesses(payload) {
  const list = document.getElementById("cpu-process-list");
  list.replaceChildren();
  const sampledAt = Date.parse(payload?.sampled_at);
  if (!payload?.available || !Number.isFinite(sampledAt) || Math.abs(Date.now() - sampledAt) > 15_000 || !Array.isArray(payload.processes)) {
    list.textContent = "Process metrics unavailable";
    return;
  }
  for (const process of payload.processes.slice(0, 3)) {
    if (!Number.isFinite(process.cpu_pct)) continue;
    const row = elementWithClass("div", "cpu-process-row");
    row.append(elementWithClass("span", "", process.name || "Unknown"), elementWithClass("span", "", `${process.cpu_pct.toFixed(1)}%`));
    list.append(row);
  }
  if (!list.childElementCount) list.textContent = "Process metrics unavailable";
}

async function refreshResources() {
  if (state.resourceInFlight || document.visibilityState !== "visible") return;
  state.resourceInFlight = true;
  try {
    const [resources, history, processes] = await Promise.allSettled([
      fetchJSON("/api/resources"),
      loadResourceHistory(),
      fetchJSON("/api/processes"),
    ]);
    showProcesses(processes.status === "fulfilled" ? processes.value : null);
    if (resources.status === "rejected") throw resources.reason;
    showResourceSample(resources.value);
    if (history.status === "rejected") renderNetworkChart();
    state.resourceOK = true;
    noteSuccess();
  } catch {
    recordResourceGap();
    elements.resourceMessage.hidden = false;
    elements.resourceMessage.textContent = "Resource data could not be refreshed. Showing the last sample.";
    state.resourceOK = false;
  } finally {
    state.resourceInFlight = false;
    updateConnection();
  }
}

async function refreshSessions() {
  if (state.sessionInFlight || document.visibilityState !== "visible") return;
  state.sessionInFlight = true;
  try {
    const [sessions, nodes, plex] = await Promise.allSettled([
      fetchJSON("/api/sessions").then(payload => {
        if (!Array.isArray(payload)) throw new Error("Invalid Silo sessions");
        return payload;
      }),
      fetchJSON("/api/nodes"),
      fetchJSON("/api/plex/sessions").then(payload => {
        if (typeof payload?.enabled !== "boolean" || !Array.isArray(payload.sessions)) throw new Error("Invalid Plex sessions");
        return payload;
      }),
    ]);
    state.sessionsOK = sessions.status === "fulfilled";
    state.nodesOK = nodes.status === "fulfilled";
    state.plexOK = plex.status === "fulfilled" ? (plex.value.enabled ? true : null) : false;
    const messages = [];
    if (!state.sessionsOK) messages.push("Silo playback is unavailable.");
    if (state.plexOK === false) messages.push("Plex playback is unavailable. Check the server URL and token.");
    elements.sessionMessage.textContent = messages.join(" ");
    elements.sessionMessage.hidden = messages.length === 0;
    showSessions([
      ...(state.sessionsOK ? sessions.value.map(session => ({ ...session, source: "silo" })) : []),
      ...(state.plexOK === true ? plex.value.sessions.map(session => ({ ...session, source: "plex" })) : []),
    ]);
    if (nodes.status === "fulfilled") showNodes(nodes.value);
    else {
      elements.nodeSummary.textContent = "Unavailable";
      elements.nodes.replaceChildren(elementWithClass("div", "empty-state", "Node status could not be refreshed."));
    }
    if (state.sessionsOK || state.nodesOK || state.plexOK === true) noteSuccess();
  } finally {
    state.sessionInFlight = false;
    updateConnection();
  }
}

async function refreshAll() {
  if (elements.refreshButton) elements.refreshButton.disabled = true;
  await Promise.all([refreshResources(), refreshSessions()]);
  if (elements.refreshButton) elements.refreshButton.disabled = false;
}

function startPolling() {
  stopPolling();
  state.resourceTimer = window.setInterval(refreshResources, RESOURCE_POLL_INTERVAL_MS);
  state.sessionTimer = window.setInterval(refreshSessions, SESSION_POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.resourceTimer !== null) window.clearInterval(state.resourceTimer);
  if (state.sessionTimer !== null) window.clearInterval(state.sessionTimer);
  state.resourceTimer = null;
  state.sessionTimer = null;
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    for (const svg of chartViews.keys()) stopScrub(svg);
    await nextPaint();
    try {
      await loadResourceHistory();
    } catch {
      redrawCharts();
    }
    await refreshAll();
    startPolling();
  } else stopPolling();
});

window.addEventListener("pageshow", async () => {
  await nextPaint();
  redrawCharts();
});
window.addEventListener("resize", () => window.requestAnimationFrame(redrawCharts));
window.addEventListener("monitor-settings-change", event => {
  if ([2, 3, 4, 5].includes(event.detail?.chartMinutes)) state.chartMinutes = event.detail.chartMinutes;
  window.requestAnimationFrame(() => {
    for (const svg of chartViews.keys()) stopScrub(svg);
    redrawCharts();
  });
});

window.addEventListener("online", () => void refreshAll());
window.addEventListener("offline", () => setConnection("offline", "Offline"));
elements.refreshButton?.addEventListener("click", () => void refreshAll());
for (const button of elements.tabButtons) {
  button.addEventListener("click", () => setView(button.dataset.tab));
}

setupChartScrubbing(elements.cpuChart, elements.cpuValue, elements.cpuDetail);
setupChartScrubbing(elements.ramChart, elements.ramValue, elements.ramDetail);
setupNetworkChartScrubbing();
renderChart(elements.cpuChart, state.cpu, "#ee8b9d", elements.cpuRangeStart);
renderChart(elements.ramChart, state.memory, "#4bc7b1", elements.ramRangeStart);
renderNetworkChart();

async function initialize() {
  try {
    await loadResourceHistory();
  } catch {
    // The current resource endpoint still provides a usable live view.
  }
  await refreshAll();
  startPolling();
}

void initialize();