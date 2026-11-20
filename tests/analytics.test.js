"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

["data", "infra", "analytics"].forEach((f) => require(`../globe/${f}.js`));
const GX = globalThis.GX;

test("haversine matches known distances", () => {
  assert.ok(Math.abs(GX.haversineKm(40.7128, -74.006, 51.5072, -0.1276) - 5570) < 30, "NYC to London");
  assert.equal(GX.haversineKm(10, 10, 10, 10), 0);
});

test("geofences: circle, polygon and degenerate polygon", () => {
  const c = { type: "circle", lat: 26.57, lon: 56.25, rKm: 100 };
  assert.equal(GX.inFence(c, 26.9, 56.0), true);
  assert.equal(GX.inFence(c, 30, 56), false);
  const poly = { type: "polygon", ring: [[0, 0], [10, 0], [10, 10], [0, 10]] };
  assert.equal(GX.inFence(poly, 5, 5), true);
  assert.equal(GX.inFence(poly, 15, 5), false);
  assert.equal(GX.inFence({ type: "polygon", ring: [[0, 0], [1, 1]] }, 0.5, 0.5), false);
});

test("exposure is cumulative per ring, sorted by distance, and counts ag belts by their edge", () => {
  const rings = GX.exposure(25.0, 55.0, [10, 50, 250, 500], GX.INFRA);
  assert.deepEqual(rings.map((r) => r.r), [10, 50, 250, 500]);
  for (let i = 1; i < rings.length; i++) assert.ok(rings[i].items.length >= rings[i - 1].items.length);
  assert.ok(rings[1].items.some((x) => x.item.n === "Jebel Ali"));
  assert.ok(rings[3].counts.refinery >= 1);
  const d = rings[3].items.map((x) => x.d);
  assert.deepEqual(d, d.slice().sort((a, b) => a - b));
  const iowa = GX.exposure(41.0, -93.0, [50], GX.INFRA)[0].items.map((x) => x.item.n);
  assert.ok(iowa.includes("US Corn Belt (Iowa)"));
  assert.ok(GX.exposureTags(rings[3].items).includes("Crude (CL)"));
});

test("line of sight: flat ground is visible, a ridge blocks, and curvature hides distant low targets", () => {
  const flat = Array(21).fill(0);
  assert.equal(GX.losProfile(flat, 5, 2, 2).visible, true);
  const ridge = flat.slice(); ridge[10] = 300;
  const r = GX.losProfile(ridge, 5, 2, 2);
  assert.equal(r.visible, false);
  assert.ok(Math.abs(r.blockedAtKm - 2.5) < 0.3);
  assert.equal(GX.losProfile(Array(21).fill(0), 80, 2, 2).visible, false, "80 km at 2 m heights is beyond the horizon");
  assert.equal(GX.losProfile(Array(21).fill(0), 80, 500, 500).visible, true, "tall endpoints see over the curve");
});

test("threat rating thresholds", () => {
  assert.equal(GX.threatRating([]), "LOW");
  assert.equal(GX.threatRating([{ sev: "info" }]), "LOW");
  assert.equal(GX.threatRating(Array(60).fill({ sev: "info" })), "LOW", "a pile of minor events stays low");
  assert.equal(GX.threatRating(Array(60).fill({ sev: "info" }).concat([{ sev: "elevated" }])), "ELEVATED");
  assert.equal(GX.threatRating([{ sev: "elevated" }, { sev: "elevated" }]), "ELEVATED");
  assert.equal(GX.threatRating([{ sev: "high" }, { sev: "elevated" }]), "HIGH");
  assert.equal(GX.threatRating([{ sev: "critical" }]), "CRITICAL");
  assert.equal(GX.threatRating(Array(4).fill({ sev: "high" })), "CRITICAL", "several highs escalate");
  assert.equal(GX.threatRating(Array(8).fill({ sev: "elevated" })), "HIGH", "many elevated events escalate one step");
});

test("briefing summarises hazards, supply chain, airspace and cyber, and escalates on fence alerts", () => {
  const events = [
    { kind: "quake", cat: "nature", sev: "high", mag: 6.2, title: "M 6.2 - 20 km N of Hualien, Taiwan", t: 1 },
    { kind: "storm", cat: "nature", sev: "elevated", wind: 50, title: "Typhoon X", t: 2 },
    { kind: "story", cat: "macro", sev: "info", title: "Tariff threat", t: 3 }
  ];
  const b = GX.buildBriefing({ scope: "Taiwan Strait", events, chokepoints: ["Taiwan Strait"], vessels: { count: 12, dark: 2, simulated: true },
    aircraft: { count: 30, military: 3 }, gnss: ["Baltic"], outages: ["TW", "CN", "JP"], exposed: ["TSMC Hsinchu"], tags: ["Semis (SOX, SMH)"], now: 5 });
  assert.equal(b.rating, "HIGH");
  assert.match(b.headline, /3 active events in Taiwan Strait/);
  const by = Object.fromEntries(b.sections.map((s) => [s.title, s]));
  assert.match(by["Natural hazards"].lines[0], /1 earthquake, strongest M 6\.2/);
  assert.equal(by["Supply chain"].rating, "HIGH");
  assert.match(by["Supply chain"].lines.join(" "), /simulated/);
  assert.equal(by["Airspace and navigation"].rating, "HIGH");
  assert.equal(by["Cyber and connectivity"].rating, "HIGH");
  const empty = GX.buildBriefing({ scope: "view", events: [], now: 1 });
  assert.equal(empty.rating, "LOW");
  assert.ok(empty.sections.every((s) => s.rating === "LOW"));
  assert.equal(GX.buildBriefing({ events: [], fenceAlerts: ["Vessel X entered Hormuz"], now: 1 }).rating, "HIGH");
});

test("share state round-trips and rejects malformed or out-of-range input", () => {
  const st = { lat: 26.57, lon: 56.25, alt: 350000, h: 40, p: -35, t: 1795000000000, base: "dark", win: "7d", layers: ["quake", "supply"], sel: "usgs-abc123" };
  assert.deepEqual(GX.decodeState(GX.encodeState(st)), st);
  assert.equal(GX.decodeState("not base64 !!"), null);
  assert.equal(GX.decodeState(GX.encodeState({ lat: 200, lon: 0, alt: 100 })), null);
  assert.equal(GX.decodeState(GX.encodeState({ lat: 10, lon: 10 })), null);
  const evil = GX.decodeState(GX.encodeState({ lat: 1, lon: 1, alt: 1000, base: "<script>", layers: ["okay", "<b>", 5], sel: "<img onerror=x>" }));
  assert.equal(evil.base, null);
  assert.deepEqual(evil.layers, ["okay"]);
  assert.equal(evil.sel, null);
  assert.equal(GX.decodeState(""), null);
});

test("satellite horizon radius grows with altitude and datasets are sane", () => {
  assert.ok(GX.satHorizonKm(800) > 2900 && GX.satHorizonKm(800) < 3100);
  assert.ok(GX.satHorizonKm(35786) > 9000);
  [].concat(GX.INFRA, GX.GNSS_ZONES, GX.LANDINGS).forEach((p) => assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180, p.n || p.name));
  GX.INFRA.forEach((p) => assert.ok(GX.INFRA_TYPES[p.t], p.n));
  assert.equal(GX.camLinks("Port of Rotterdam")[0].url.startsWith("https://www.youtube.com/"), true);
});
