'use strict';

const http = require('http');
const { auraSvg, auraTraits } = require('./aura');

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

const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet X-Ray — multi-chain wallet snapshot for AI agents</title>
<meta property="og:title" content="Wallet X-Ray">
<meta property="og:description" content="One call. Any EVM wallet. 8 chains. Built for the agent economy — live on OKX.AI.">
<style>
:root{--bg:#0a0c18;--panel:#0f1220;--line:#2d344b;--fg:#e1e6f0;--dim2:#828ca0;--green:#38e6b0;--blue:#56a0ff;--yellow:#ffc85a}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--fg);font-family:ui-monospace,Menlo,Consolas,monospace;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 16px}
h1{font-size:2.2rem;margin:18px 0 6px}
.tag{color:var(--green);margin-bottom:4px}
.sub{color:var(--dim2);font-size:.85rem;margin-bottom:32px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;max-width:720px;width:100%;margin-bottom:20px}
.row{display:flex;gap:10px;flex-wrap:wrap}
input{flex:1;min-width:260px;background:#0a0d1a;border:1px solid var(--line);border-radius:8px;color:var(--fg);padding:12px;font:inherit}
button{background:var(--green);color:#06251c;border:0;border-radius:8px;padding:12px 22px;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
pre{overflow-x:auto;background:#0a0d1a;border:1px solid var(--line);border-radius:8px;padding:14px;font-size:.8rem;line-height:1.45;margin-top:14px}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:.9rem}
td,th{padding:8px 6px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--dim2);font-weight:400}
.usd{color:var(--blue);text-align:right}.bal{text-align:right}
.total{font-size:1.4rem;color:var(--green);font-weight:700}
.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:2px 10px;font-size:.75rem;color:var(--dim2);margin:2px}
a{color:var(--blue);text-decoration:none}
.err{color:#ff7a7a;margin-top:12px}
footer{color:var(--dim2);font-size:.8rem;margin-top:12px;text-align:center}
img.logo{width:96px;height:96px;border-radius:20px}
</style></head><body>
<img class="logo" src="https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/e2f3e932-0733-4d66-b620-89d18ba949ab.png" alt="">
<h1>Wallet X-Ray</h1>
<div class="tag">One call. Any EVM wallet. 8 chains.</div>
<div class="sub">Agent service #6011 on <a href="https://www.okx.ai/agents/6011">OKX.AI</a> · <a href="https://github.com/nickisanders/wallet-xray">source</a></div>
<div class="card">
  <div class="row">
    <input id="addr" placeholder="0x… paste any EVM address" value="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045">
    <button id="go" onclick="scan()">X-Ray</button>
  </div>
  <div id="out"></div>
</div>
<div class="card">
  <div style="color:var(--dim2);font-size:.85rem">For agents</div>
  <pre>GET /xray?address=0x…            → JSON snapshot
POST /xray {"address":"0x…"}     → same

returns: per-chain native balance, USD value, tx count,
account type (eoa | contract | eoa-delegated-7702), totals</pre>
  <div>
    <span class="pill">Ethereum</span><span class="pill">Base</span><span class="pill">Arbitrum</span><span class="pill">Optimism</span><span class="pill">Polygon</span><span class="pill">BNB Chain</span><span class="pill">Avalanche</span><span class="pill">X Layer</span>
  </div>
</div>
<footer>free per call · no API keys · built for the OKX.AI Genesis Hackathon · #OKXAI</footer>
<script>
async function scan(){
  const btn=document.getElementById('go'),out=document.getElementById('out');
  const a=document.getElementById('addr').value.trim();
  btn.disabled=true;out.innerHTML='<div class="sub" style="margin-top:14px">scanning 8 chains…</div>';
  try{
    const r=await fetch('/xray?address='+encodeURIComponent(a));
    const d=await r.json();
    if(!r.ok){out.innerHTML='<div class="err">'+(d.error||'error')+'</div>';return}
    let rows=d.chains.map(c=>'<tr><td>'+c.name+'</td><td class="bal">'+(c.error?'—':c.balance.toFixed(4)+' '+c.symbol)+'</td><td class="usd">'+(c.usd!=null?'$'+c.usd.toLocaleString():'—')+'</td><td>'+(c.txCount!=null?c.txCount.toLocaleString():'—')+'</td><td>'+(c.accountType||'—')+'</td></tr>').join('');
    out.innerHTML='<div style="margin-top:18px" class="total">$'+(d.totalUsd!=null?d.totalUsd.toLocaleString():'?')+
      '</div><div class="sub">total across '+d.chainsScanned+' chains · active on '+d.activeOn.length+
      '</div><table><tr><th>chain</th><th class="bal">balance</th><th class="usd">usd</th><th>txs</th><th>type</th></tr>'+rows+'</table>';
  }catch(e){out.innerHTML='<div class="err">scan failed — try again</div>'}
  btn.disabled=false;
}
</script></body></html>`;

const AURA_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet Aura — your wallet, as art</title>
<meta property="og:title" content="Wallet Aura">
<meta property="og:description" content="Deterministic generative art from a wallet's real on-chain life. Live on OKX.AI.">
<style>
*{box-sizing:border-box;margin:0}
body{background:#06070f;color:#e1e6f0;font-family:ui-monospace,Menlo,Consolas,monospace;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:44px 16px}
h1{font-size:2.2rem;margin:6px 0}
.tag{color:#b28dff;margin-bottom:4px}
.sub{color:#828ca0;font-size:.85rem;margin-bottom:28px;text-align:center}
.card{background:#0d0f1e;border:1px solid #2d344b;border-radius:14px;padding:22px;max-width:560px;width:100%;margin-bottom:18px}
.row{display:flex;gap:10px;flex-wrap:wrap}
input{flex:1;min-width:240px;background:#0a0d1a;border:1px solid #2d344b;border-radius:8px;color:#e1e6f0;padding:12px;font:inherit}
button{background:#b28dff;color:#1b0f35;border:0;border-radius:8px;padding:12px 22px;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
#art{width:100%;border-radius:12px;margin-top:16px;display:none}
.traits{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.pill{border:1px solid #2d344b;border-radius:99px;padding:3px 12px;font-size:.78rem;color:#9aa5bd}
.pill b{color:#b28dff}
a{color:#56a0ff;text-decoration:none}
footer{color:#828ca0;font-size:.8rem;margin-top:10px;text-align:center}
.err{color:#ff7a7a;margin-top:12px}
</style></head><body>
<h1>Wallet Aura</h1>
<div class="tag">every wallet has an aura. see yours.</div>
<div class="sub">generative art from real on-chain life · sibling of <a href="/">Wallet X-Ray</a> · live on <a href="https://www.okx.ai">OKX.AI</a></div>
<div class="card">
  <div class="row">
    <input id="addr" placeholder="0x… any EVM address" value="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045">
    <button id="go" onclick="aura()">Reveal</button>
  </div>
  <img id="art" alt="wallet aura">
  <div class="traits" id="traits"></div>
  <div id="msg"></div>
</div>
<footer>deterministic: same wallet, same aura · balances, chains, and activity shape the art · #OKXAI</footer>
<script>
async function aura(){
  const btn=document.getElementById('go'),img=document.getElementById('art'),tr=document.getElementById('traits'),msg=document.getElementById('msg');
  const a=document.getElementById('addr').value.trim();
  btn.disabled=true;msg.innerHTML='<div class="sub" style="margin-top:12px">reading the chains…</div>';tr.innerHTML='';
  try{
    const r=await fetch('/aura?format=json&address='+encodeURIComponent(a));
    const d=await r.json();
    if(!r.ok){msg.innerHTML='<div class="err">'+(d.error||'error')+'</div>';btn.disabled=false;return}
    img.src='data:image/svg+xml;utf8,'+encodeURIComponent(d.svg);img.style.display='block';
    const t=d.traits;
    tr.innerHTML='<span class="pill">archetype <b>'+t.archetype+'</b></span>'+
      '<span class="pill">chains <b>'+t.activeChains+'/8</b></span>'+
      (t.dominantChain?'<span class="pill">home <b>'+t.dominantChain+'</b></span>':'')+
      '<span class="pill">activity <b>'+t.totalTx.toLocaleString()+' txs</b></span>'+
      (t.delegated?'<span class="pill"><b>7702 cyborg</b></span>':'');
    msg.innerHTML='';
  }catch(e){msg.innerHTML='<div class="err">failed — try again</div>'}
  btn.disabled=false;
}
</script></body></html>`;

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
  if (url.pathname === '/' && req.method === 'GET') {
    if ((req.headers.accept || '').includes('text/html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(LANDING_HTML);
    }
    return send(res, 200, INFO);
  }

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

  if (url.pathname === '/aura') {
    const address = url.searchParams.get('address');
    if (!address && (req.headers.accept || '').includes('text/html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(AURA_HTML);
    }
    if (rateLimited(ip)) return send(res, 429, { error: 'rate limit: 30 requests/minute' });
    if (!address || !ADDR_RE.test(String(address).trim())) {
      return send(res, 400, { error: 'provide a valid EVM address: 0x + 40 hex chars', example: '/aura?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' });
    }
    try {
      const data = await xray(String(address).trim());
      if (url.searchParams.get('format') === 'json') {
        return send(res, 200, { address: data.address, traits: auraTraits(data), svg: auraSvg(data) });
      }
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*',
      });
      return res.end(auraSvg(data));
    } catch (e) {
      return send(res, 500, { error: 'aura generation failed, try again' });
    }
  }

  return send(res, 404, { error: 'not found', hint: 'GET / for usage' });
});

server.listen(PORT, () => {
  console.log(`wallet-xray listening on :${PORT}`);
});
