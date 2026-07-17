'use strict';

// Wallet Aura: deterministic generative SVG portrait of a wallet,
// derived entirely from its real multi-chain snapshot.

const PALETTE = {
  ethereum: '#627eea',
  base: '#0052ff',
  arbitrum: '#28a0f0',
  optimism: '#ff0420',
  polygon: '#8247e5',
  bsc: '#f0b90b',
  avalanche: '#e84142',
  xlayer: '#38e6b0',
};

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromAddress(address) {
  const hex = address.toLowerCase().replace('0x', '');
  let s = 0;
  for (let i = 0; i < hex.length; i += 8) {
    s ^= parseInt(hex.slice(i, i + 8), 16) | 0;
  }
  return s;
}

function archetype(data) {
  const ok = data.chains.filter((c) => !c.error);
  const totalTx = ok.reduce((s, c) => s + (c.txCount || 0), 0);
  const activeChains = data.activeOn.length;
  const delegated = ok.some((c) => c.accountType === 'eoa-delegated-7702');
  const contract = ok.some((c) => c.accountType === 'contract');
  const usd = data.totalUsd || 0;

  if (contract) return 'Construct';
  if (usd === 0 && totalTx === 0) return 'Ghost';
  if (usd > 1_000_000) return 'Leviathan';
  if (delegated) return 'Cyborg';
  if (usd > 50_000) return 'Whale';
  if (activeChains >= 6) return 'Nomad';
  if (totalTx > 5_000) return 'Machine';
  if (totalTx > 500) return 'Voyager';
  if (usd > 1_000) return 'Keeper';
  return 'Wanderer';
}

function auraTraits(data) {
  const ok = data.chains.filter((c) => !c.error);
  const dominant = ok.reduce((a, b) => ((b.usd || 0) > (a.usd || 0) ? b : a), ok[0] || {});
  return {
    archetype: archetype(data),
    dominantChain: dominant.name || null,
    activeChains: data.activeOn.length,
    totalUsd: data.totalUsd,
    totalTx: ok.reduce((s, c) => s + (c.txCount || 0), 0),
    delegated: ok.some((c) => c.accountType === 'eoa-delegated-7702'),
    isContract: ok.some((c) => c.accountType === 'contract'),
  };
}

function auraSvg(data) {
  const addr = data.address;
  const rng = mulberry32(seedFromAddress(addr));
  const ok = data.chains.filter((c) => !c.error);
  const totalUsd = data.totalUsd || 0;
  const traits = auraTraits(data);
  const S = 800, C = S / 2;
  const hue = Math.floor(rng() * 360);
  const parts = [];

  parts.push(`<defs>
  <radialGradient id="bg" cx="50%" cy="42%" r="75%">
    <stop offset="0%" stop-color="hsl(${hue},45%,14%)"/>
    <stop offset="60%" stop-color="hsl(${(hue + 40) % 360},50%,8%)"/>
    <stop offset="100%" stop-color="#06070f"/>
  </radialGradient>
  <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="soft" x="-80%" y="-80%" width="260%" height="260%">
    <feGaussianBlur stdDeviation="18"/>
  </filter>
</defs>`);
  parts.push(`<rect width="${S}" height="${S}" fill="url(#bg)"/>`);

  // nebula blobs seeded by address
  for (let i = 0; i < 5; i++) {
    const bx = 100 + rng() * 600, by = 100 + rng() * 600;
    const br = 60 + rng() * 130;
    const bh = (hue + rng() * 120) % 360;
    parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${br.toFixed(1)}" fill="hsl(${bh},60%,30%)" opacity="0.12" filter="url(#soft)"/>`);
  }

  // orbital arcs: one per chain with life on it
  const live = ok.filter((c) => (c.usd || 0) > 0 || (c.txCount || 0) > 0);
  const usdSum = live.reduce((s, c) => s + (c.usd || 0), 0) || 1;
  live.forEach((c, i) => {
    const share = (c.usd || 0) / usdSum;
    const radius = 130 + i * 34;
    const sweep = 50 + Math.min(280, 280 * (share + Math.min((c.txCount || 0), 200) / 800));
    const rot = rng() * 360;
    const width = (3 + 22 * share).toFixed(1);
    const col = PALETTE[c.chain] || '#8fa0c0';
    const dash = c.txCount > 0 ? `${(4 + (c.txCount % 14)).toFixed(0)} ${(2 + (c.txCount % 5)).toFixed(0)}` : 'none';
    const a0 = (rot * Math.PI) / 180, a1 = ((rot + sweep) * Math.PI) / 180;
    const x0 = C + radius * Math.cos(a0), y0 = C + radius * Math.sin(a0);
    const x1 = C + radius * Math.cos(a1), y1 = C + radius * Math.sin(a1);
    const large = sweep > 180 ? 1 : 0;
    parts.push(`<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${width}" stroke-linecap="round" ${dash === 'none' ? '' : `stroke-dasharray="${dash}"`} opacity="0.85" filter="url(#glow)"/>`);
  });

  // particles: total activity as stardust
  const n = Math.max(10, Math.min(80, Math.floor(traits.totalTx / 12) + 10));
  for (let i = 0; i < n; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 100 + rng() * 300;
    const px = C + rad * Math.cos(ang), py = C + rad * Math.sin(ang);
    const col = live.length ? PALETTE[live[Math.floor(rng() * live.length)].chain] : '#8fa0c0';
    parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(0.8 + rng() * 2.2).toFixed(1)}" fill="${col}" opacity="${(0.25 + rng() * 0.6).toFixed(2)}"/>`);
  }

  // core: what kind of being is this
  const coreCol = `hsl(${hue},70%,72%)`;
  if (traits.isContract) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${(C + 58 * Math.cos(a)).toFixed(1)},${(C + 58 * Math.sin(a)).toFixed(1)}`);
    }
    parts.push(`<polygon points="${pts.join(' ')}" fill="none" stroke="${coreCol}" stroke-width="5" filter="url(#glow)"/>`);
    parts.push(`<polygon points="${pts.join(' ')}" fill="${coreCol}" opacity="0.15"/>`);
  } else {
    parts.push(`<circle cx="${C}" cy="${C}" r="52" fill="none" stroke="${coreCol}" stroke-width="5" filter="url(#glow)"/>`);
    parts.push(`<circle cx="${C}" cy="${C}" r="52" fill="${coreCol}" opacity="0.12"/>`);
  }
  if (traits.delegated) {
    parts.push(`<circle cx="${C}" cy="${C}" r="72" fill="none" stroke="#38e6b0" stroke-width="2.5" stroke-dasharray="6 5" filter="url(#glow)"/>`);
  }
  // wealth pulse: core inner dot scaled by usd magnitude
  const mag = totalUsd > 0 ? Math.min(30, 6 + Math.log10(totalUsd + 1) * 4.5) : 4;
  parts.push(`<circle cx="${C}" cy="${C}" r="${mag.toFixed(1)}" fill="${coreCol}" opacity="0.9" filter="url(#glow)"/>`);

  // caption
  const short = addr.slice(0, 6) + '…' + addr.slice(-4);
  parts.push(`<text x="${C}" y="${S - 34}" font-family="Menlo,monospace" font-size="17" fill="#9aa5bd" text-anchor="middle">${short} · ${traits.archetype}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${parts.join('\n')}</svg>`;
}

module.exports = { auraSvg, auraTraits };
