/* Reference datasets for the analyst tools. Coordinates are approximate and curated by hand for context:
 * they are not an authoritative asset register. Pure data, no DOM. */
(function (g) {
  "use strict";
  var GX = (g.GX = g.GX || {});

  /* Exposure tags per infrastructure type: asset / commodity sensitivities for the ripple simulator. */
  GX.INFRA_TYPES = {
    port: { label: "Port", color: "#2DD4BF", tags: ["Shipping rates (BDI, FBX)", "Container lines"] },
    airport: { label: "Airport", color: "#C9D1D9", tags: ["Airlines (JETS)", "Air freight"] },
    refinery: { label: "Refinery / energy terminal", color: "#FFA726", tags: ["Crude (CL)", "Brent", "Gasoline (RB)", "Nat gas (NG)"] },
    fab: { label: "Semiconductor fab", color: "#A371F7", tags: ["Semis (SOX, SMH)", "NQ"] },
    power: { label: "Power / nuclear / hydro", color: "#F2CC60", tags: ["Utilities (XLU)", "Nat gas (NG)", "Uranium (URA)"] },
    ag: { label: "Agricultural belt", color: "#7EE787", tags: ["Wheat (ZW)", "Corn (ZC)", "Soybeans (ZS)"] },
    dc: { label: "Data-center hub", color: "#79C0FF", tags: ["Cloud / tech (NQ)", "Cloud REITs"] }
  };

  function P(n, t, lat, lon, r) { return { n: n, t: t, lat: lat, lon: lon, r: r || 0 }; }

  GX.INFRA = [
    P("Shanghai (Yangshan)", "port", 30.63, 122.06), P("Singapore", "port", 1.26, 103.82), P("Ningbo-Zhoushan", "port", 29.93, 121.85), P("Shenzhen (Yantian)", "port", 22.57, 114.28),
    P("Busan", "port", 35.1, 129.04), P("Rotterdam", "port", 51.95, 4.14), P("Antwerp", "port", 51.27, 4.4), P("Hamburg", "port", 53.54, 9.97),
    P("Los Angeles / Long Beach", "port", 33.74, -118.27), P("Jebel Ali", "port", 25.01, 55.06), P("Port Said", "port", 31.26, 32.3), P("Houston", "port", 29.73, -95.27),
    P("New York / New Jersey", "port", 40.68, -74.04), P("Santos", "port", -23.96, -46.3), P("Hong Kong", "port", 22.3, 114.15), P("Tanjung Pelepas", "port", 1.36, 103.55),
    P("Piraeus", "port", 37.94, 23.64), P("Algeciras", "port", 36.13, -5.43), P("Balboa (Panama)", "port", 8.95, -79.57), P("Colombo", "port", 6.95, 79.85), P("Durban", "port", -29.87, 31.03),
    P("Heathrow", "airport", 51.47, -0.45), P("JFK", "airport", 40.64, -73.78), P("Dubai (DXB)", "airport", 25.25, 55.36), P("Hong Kong (HKG)", "airport", 22.31, 113.91),
    P("Tokyo Haneda", "airport", 35.55, 139.78), P("Singapore Changi", "airport", 1.36, 103.99), P("Frankfurt", "airport", 50.03, 8.57), P("Los Angeles (LAX)", "airport", 33.94, -118.41),
    P("Memphis (FedEx hub)", "airport", 35.04, -89.98), P("Incheon", "airport", 37.46, 126.44), P("Paris CDG", "airport", 49.01, 2.55), P("Istanbul", "airport", 41.26, 28.74),
    P("Shanghai Pudong", "airport", 31.14, 121.8), P("Anchorage", "airport", 61.17, -150.0), P("Atlanta", "airport", 33.64, -84.43),
    P("Ras Tanura", "refinery", 26.64, 50.16), P("Abqaiq", "refinery", 25.94, 49.68), P("Jamnagar", "refinery", 22.35, 69.87), P("Port Arthur (TX)", "refinery", 29.89, -93.94),
    P("Baytown (TX)", "refinery", 29.74, -95.02), P("Europoort", "refinery", 51.95, 4.03), P("Ulsan", "refinery", 35.5, 129.38), P("Yanbu", "refinery", 24.09, 38.06),
    P("Fujairah terminal", "refinery", 25.17, 56.35), P("Cushing (OK) hub", "refinery", 35.99, -96.77), P("Sabine Pass LNG", "refinery", 29.73, -93.87), P("Ras Laffan LNG", "refinery", 25.92, 51.55),
    P("TSMC Hsinchu", "fab", 24.78, 121.01), P("TSMC Tainan", "fab", 23.1, 120.28), P("TSMC Taichung", "fab", 24.21, 120.62), P("Samsung Pyeongtaek", "fab", 37.0, 127.0),
    P("SK hynix Icheon", "fab", 37.28, 127.44), P("Intel Chandler (AZ)", "fab", 33.28, -111.88), P("Intel Hillsboro (OR)", "fab", 45.54, -122.93), P("GlobalFoundries Malta (NY)", "fab", 42.97, -73.75),
    P("Micron Boise", "fab", 43.52, -116.17), P("ASML Veldhoven", "fab", 51.41, 5.4), P("TSMC Kumamoto (JASM)", "fab", 32.85, 130.8),
    P("Three Gorges Dam", "power", 30.82, 111.0), P("Itaipu Dam", "power", -25.41, -54.59), P("Zaporizhzhia NPP", "power", 47.51, 34.59), P("Kashiwazaki-Kariwa NPP", "power", 37.43, 138.6),
    P("Palo Verde NPP (AZ)", "power", 33.39, -112.86), P("Bruce Power (ON)", "power", 44.33, -81.6),
    P("US Corn Belt (Iowa)", "ag", 42.0, -93.5, 450), P("Ukraine grain belt", "ag", 49.0, 32.0, 400), P("Mato Grosso soy (Brazil)", "ag", -13.0, -55.5, 450),
    P("Punjab / Haryana wheat", "ag", 30.5, 75.5, 250), P("Argentine Pampas", "ag", -33.0, -62.0, 400), P("Australian wheatbelt", "ag", -31.5, 117.5, 350), P("North China Plain", "ag", 36.0, 115.5, 350),
    P("Ashburn (VA) data centers", "dc", 39.04, -77.49), P("Dublin data centers", "dc", 53.35, -6.26), P("Frankfurt data centers", "dc", 50.11, 8.68),
    P("The Dalles (OR)", "dc", 45.6, -121.18), P("Council Bluffs (IA)", "dc", 41.26, -95.86), P("Singapore data centers", "dc", 1.33, 103.75)
  ];

  /* Regions with GNSS jamming or spoofing repeatedly reported in public sources. Reference zones, not a live feed. */
  GX.GNSS_ZONES = [
    { id: "baltic", name: "Baltic Sea / Kaliningrad", lat: 55.0, lon: 20.0, r: 350, note: "Frequent civil aviation and shipping GNSS disruption reports." },
    { id: "emed", name: "Eastern Mediterranean", lat: 34.5, lon: 34.0, r: 320, note: "Recurring spoofing near Cyprus, Lebanon and Israel." },
    { id: "blacksea", name: "Black Sea", lat: 44.0, lon: 34.0, r: 420, note: "Widespread jamming reported by aircraft and vessels." },
    { id: "gulf", name: "Persian Gulf / Hormuz", lat: 26.5, lon: 54.0, r: 380, note: "Vessel position anomalies reported around the strait." },
    { id: "redsea", name: "Red Sea / Gulf of Aden", lat: 13.5, lon: 42.5, r: 320, note: "Interference reported along the shipping corridor." },
    { id: "finland", name: "Finland / Russia border", lat: 62.0, lon: 29.0, r: 250, note: "Intermittent jamming affecting aviation in the north." }
  ];

  /* Approximate submarine cable landing stations. */
  GX.LANDINGS = [
    ["Virginia Beach, US", 36.85, -75.98], ["Bude, UK", 50.83, -4.54], ["Marseille, FR", 43.3, 5.37], ["Mumbai, IN", 19.08, 72.82], ["Singapore", 1.3, 103.85],
    ["Chiba, JP", 35.37, 140.38], ["Hermosa Beach, US", 33.86, -118.4], ["Sydney, AU", -33.87, 151.21], ["Fortaleza, BR", -3.73, -38.52], ["Lagos, NG", 6.45, 3.4],
    ["Djibouti", 11.59, 43.15], ["Alexandria, EG", 31.2, 29.92], ["Fujairah, AE", 25.12, 56.33], ["Hong Kong", 22.25, 114.2], ["Sines, PT", 37.95, -8.87], ["Cape Town, ZA", -33.92, 18.42]
  ].map(function (c) { return { name: c[0], lat: c[1], lon: c[2] }; });

  /* Public live-camera directories. Keyless embeddable streams are not reliable, so cameras open as searches. */
  GX.camLinks = function (name) {
    var q = encodeURIComponent(name + " live webcam");
    return [
      { label: "YouTube live streams", url: "https://www.youtube.com/results?search_query=" + q + "&sp=EgJAAQ%253D%253D" },
      { label: "Web search", url: "https://www.google.com/search?q=" + q },
      { label: "Windy webcams", url: "https://www.windy.com/webcams" }
    ];
  };
})(globalThis);
