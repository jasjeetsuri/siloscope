"use strict";

const PlaybackActivity = (() => {
  let entries = [];
  let limit = 20;
  let pending = false;
  const list = document.getElementById("activity-list");
  const more = document.getElementById("activity-more");
  const status = document.getElementById("activity-status");
  const clock = value => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function render() {
    const expanded = new Set([...list.querySelectorAll("details[open]")].map(node => node.dataset.id));
    list.replaceChildren();
    for (const entry of entries.slice(0, limit)) {
      const row = element("li", "activity-row", "");
      const minutes = Math.floor(Math.max(0, entry.duration_seconds) / 60);
      const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes > 0 ? `${minutes}m` : `${Math.max(0, entry.duration_seconds)}s`;
      const details = element("details", "activity-item", "");
      details.dataset.id = entry.id;
      details.open = expanded.has(entry.id);
      const heading = element("summary", "activity-row-heading", "");
      const poster = element("span", "activity-poster", "");
      const fallback = element("span", "ui-icon icon-playing", "");
      fallback.setAttribute("aria-hidden", "true");
      poster.append(fallback);
      if (entry.poster_url) {
        try {
          const url = new URL(entry.poster_url, location.href);
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
            const image = document.createElement("img");
            image.alt = "";
            image.loading = "lazy";
            image.referrerPolicy = "no-referrer";
            image.src = url.href;
            image.addEventListener("error", () => image.remove(), { once: true });
            poster.append(image);
          }
        } catch {}
      }
      const copy = element("span", "activity-copy", "");
      copy.append(element("strong", "activity-title", entry.series_name || entry.title));
      const episode = [entry.season_number != null ? `S${entry.season_number}` : "", entry.episode_number != null ? `E${entry.episode_number}` : ""].filter(Boolean).join(" · ");
      const subtitle = [episode, entry.episode_name].filter(Boolean).join(" — ");
      if (subtitle) copy.append(element("span", "activity-subtitle", subtitle));
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(entry.ended_at || entry.last_seen)) / 1000));
      const ago = seconds < 60 ? "Just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : `${Math.floor(seconds / 3600)} hours ago`;
      const label = entry.status === "active" ? "Active" : ago;
      copy.append(element("span", "activity-user", [entry.user, label].filter(Boolean).join(" — ")));
      heading.append(poster, copy);
      const detail = [entry.source, entry.user, entry.method, `${duration} observed`].filter(Boolean).join(" · ");
      const start = `${entry.already_active ? "First seen" : "Start observed"} ${clock(entry.started_at)}`;
      const end = entry.ended_at ? ` · Stop observed ${clock(entry.ended_at)}` : "";
      details.append(heading, element("div", "activity-detail", detail), element("div", "activity-times", start + end));
      row.append(details);
      list.append(row);
    }
    more.hidden = entries.length <= limit;
  }
  more.addEventListener("click", () => { limit += 20; render(); });
  document.getElementById("playback-history").addEventListener("click", event => {
    setView("history");
    if (event.detail === 0) document.getElementById("activity-heading").focus({ preventScroll: true });
    refresh();
  });
  document.getElementById("activity-back").addEventListener("click", event => {
    setView("playing");
    if (event.detail === 0) document.getElementById("playback-history").focus({ preventScroll: true });
  });
  async function refresh() {
    if (pending) return;
    pending = true;
    try {
      const response = await fetch("/api/activity", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error();
      entries = payload.filter(entry => entry.status === "active" || entry.status === "stopped");
      render();
      status.textContent = entries.length ? "" : "No recent activity";
    } catch {
      status.textContent = "Activity history unavailable. Last results may be stale.";
    } finally { pending = false; }
  }
  return { refresh };
})();