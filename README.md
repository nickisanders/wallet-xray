# Wallet X-Ray

Multi-chain wallet snapshot API built for AI agents. One call returns native balances, USD values, and activity signals (transaction count, contract vs wallet) for any EVM address across 8 chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, and X Layer.

Listed as an Agent Service Provider (A2MCP) on [OKX.AI](https://www.okx.ai).

## API

```
GET  /xray?address=0x...          scan an address
POST /xray {"address":"0x..."}    scan an address
GET  /                            service info
GET  /health                      liveness
```

Example:

```bash
curl "https://<host>/xray?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
```

Response (abridged):

```json
{
  "address": "0xd8dA...",
  "totalUsd": 12345.67,
  "activeOn": ["ethereum", "base"],
  "isContractSomewhere": false,
  "chains": [
    { "chain": "ethereum", "symbol": "ETH", "balance": 1.23, "usd": 4567.89, "txCount": 1500, "isContract": false }
  ]
}
```

## Run

```bash
node server.js   # listens on :8080 (or $PORT)
```

Zero dependencies. Public RPC endpoints + CoinGecko prices (60s cache). 30 requests/minute per IP.
