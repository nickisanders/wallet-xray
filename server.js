'use strict';

const http = require('http');

const PORT = process.env.PORT || 8080;

const CHAINS = [
  { key: 'ethereum',  name: 'Ethereum',  symbol: 'ETH',  coingecko: 'ethereum',                  rpc: 'https://ethereum-rpc.publicnode.com' },
  { key: 'base',      name: 'Base',      symbol: 'ETH',  coingecko: 'ethereum',                  rpc: 'https://base-rpc.publicnode.com' },
  { key: 'arbitrum',  name: 'Arbitrum',  symbol: 'ETH',  coingecko: 'ethereum',                  rpc: 'https://arbitrum-one-rpc.publicnode.com' },
  { key: 'optimism',  name: 'Optimism',  symbol: 'ETH',  coingecko: 'ethereum',                  rpc: 'https://optimism-rpc.publicnode.com' },
  { key: 'polygon',   name: 'Polygon',   symbol: 'POL',  coingecko: 'polygon-ecosystem-token',   rpc: 'https://polygon-bor-rpc.publicnode.com' },
  { key: 'bsc',       name: 'BNB Chain', symbol: 'BNB',  coingecko: 'binancecoin',               rpc: 'https://bsc-rpc.publicnode.com' },
  { key: 'avalanche', name: 'Avalanche', symbol: 'AVAX', coingecko: 'avalanche-2',               rpc: 'https://avalanche-c-chain-rpc.publicnode.com' },
  { key: 'xlayer',    name: 'X Layer',   symbol: 'OKB',  coingecko: 'okb',                       rpc: 'https://rpc.xlayer.tech' },
];

const RPC_TIMEOUT_MS = 6000;
const PRICE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// helpers

function rpcCall(rpcUrl, method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  return fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: controller.signal,
  })
    .then((r) => r.json())
    .then((j) => {
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    })
    .finally(() => clearTimeout(timer));
}

function weiToDecimal(hexWei) {
  const wei = BigInt(hexWei);
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  return Number(whole) + Number(frac) / 1e18;
}

let priceCache = { at: 0, prices: {} };

async function getPrices() {
  if (Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;
  const ids = [...new Set(CHAINS.map((c) => c.coingecko))].join(',');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: controller.signal, headers: { accept: 'application/json' } }
    );
    if (r.ok) {
      const j = await r.json();
      const prices = {};
      for (const [id, v] of Object.entries(j)) prices[id] = v.usd;
      priceCache = { at: Date.now(), prices };
    }
  } catch (_) {
    // stale cache (or empty prices) is acceptable; usd fields become null
  } finally {
    clearTimeout(timer);
  }
  return priceCache.prices;
}

async function scanChain(chain, address, prices) {
  const out = { chain: chain.key, name: chain.name, symbol: chain.symbol };
  try {
    const [balanceHex, txCountHex, code] = await Promise.all([
      rpcCall(chain.rpc, 'eth_getBalance', [address, 'latest']),
      rpcCall(chain.rpc, 'eth_getTransactionCount', [address, 'latest']),
      rpcCall(chain.rpc, 'eth_getCode', [address, 'latest']),
    ]);
    const balance = weiToDecimal(balanceHex);
    const price = prices[chain.coingecko];
    out.balance = balance;
    out.usd = typeof price === 'number' ? Math.round(balance * price * 100) / 100 : null;
    out.txCount = parseInt(txCountHex, 16);
    const hasCode = code !== '0x' && code !== '0x0';
    // EIP-7702 delegation designator: 0xef0100 || 20-byte address
    const delegated = hasCode && code.toLowerCase().startsWith('0xef0100');
    out.accountType = delegated ? 'eoa-delegated-7702' : hasCode ? 'contract' : 'eoa';
  } catch (e) {
    out.error = 'unreachable';
  }
  return out;
}

async function xray(address) {
  const prices = await getPrices();
  const chains = await Promise.all(CHAINS.map((c) => scanChain(c, address, prices)));
  const ok = chains.filter((c) => !c.error);
  const totalUsd = ok.every((c) => c.usd === null)
    ? null
    : Math.round(ok.reduce((s, c) => s + (c.usd || 0), 0) * 100) / 100;
  const active = ok.filter((c) => c.txCount > 0 || c.balance > 0).map((c) => c.chain);
  return {
    address,
    totalUsd,
    activeOn: active,
    isContractSomewhere: ok.some((c) => c.accountType === 'contract'),
    chains,
    chainsScanned: chains.length,
    chainsUnreachable: chains.length - ok.length,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// tiny per-IP rate limit: 30 req/min

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 10_000) hits.clear();
  return arr.length > 30;
}

// ---------------------------------------------------------------------------
// http server

const INFO = {
  service: 'Wallet X-Ray',
  description:
    'Real-time snapshot of any EVM wallet: native balances and USD values across 8 chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, X Layer), plus activity signals (transaction count, contract vs wallet).',
  usage: {
    'GET /xray?address=0x...': 'scan an address',
    'POST /xray {"address":"0x..."}': 'scan an address',
    'GET /health': 'liveness check',
  },
  input: { address: 'EVM address, 0x + 40 hex chars' },
  pricing: 'free',
};

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(json);
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  if (url.pathname === '/health') return send(res, 200, { status: 'ok' });
  if (url.pathname === '/' && req.method === 'GET') return send(res, 200, INFO);

  if (url.pathname === '/xray') {
    if (rateLimited(ip)) return send(res, 429, { error: 'rate limit: 30 requests/minute' });

    let address = url.searchParams.get('address');
    if (!address && req.method === 'POST') {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 4096) req.destroy(); });
        req.on('end', () => resolve(data));
        req.on('error', () => resolve(''));
      });
      try { address = JSON.parse(body).address; } catch (_) { /* fall through */ }
    }

    if (!address || !ADDR_RE.test(String(address).trim())) {
      return send(res, 400, { error: 'provide a valid EVM address: 0x + 40 hex chars', example: '/xray?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' });
    }

    try {
      const result = await xray(String(address).trim());
      return send(res, 200, result);
    } catch (e) {
      return send(res, 500, { error: 'scan failed, try again' });
    }
  }

  return send(res, 404, { error: 'not found', hint: 'GET / for usage' });
});

server.listen(PORT, () => {
  console.log(`wallet-xray listening on :${PORT}`);
});
