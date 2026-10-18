# baconservices-mcp

An MCP server that lets an AI agent buy image work from [Bacon Services](https://baconservices.com),
one call at a time, paid in USDC on Base over [x402](https://x402.org) from **your own wallet**,
within spending limits you set. There's no account and no API key: the agent calls a tool, the
server checks the price against your limits, signs a USDC payment for exactly that price, and
returns the result.

Also listed in the MCP Registry as `io.github.afmontoya/baconservices-mcp`.

## What it sells

| Tool | Does | Price (2026-10-17) |
|---|---|---|
| `remove_background` | Removes the background from one photo; returns a transparent PNG at the photo's size | 0.20 USDC |
| `optimize_image` | Resizes so the longest side ≤ `max_width` (64–4096, default 1600) and encodes WebP at `quality` (40–95, default 80) | 0.01 USDC |
| `image_palette` | The colours one image is mostly made of, as JSON: up to `count` (1–12, default 6) hex colours with their share, `include_neutrals` (default true) | 0.01 USDC |
| `brand_from_url` | Reads one public web page (`url`) and returns its brand as JSON: name, description, logo URLs, colours, fonts, social profiles. No JavaScript runs; robots.txt is respected | 0.03 USDC |

Image tools take PNG, JPEG or WebP up to 8 MB, as `image_url` (public https) or `image_path` (a
local file). `remove_background` and `optimize_image` return a signed download link (valid 24
hours); `image_palette` and `brand_from_url` return their JSON result in the tool result. Add
`save_to` to write either kind to disk. Prices come from Bacon's live catalog, and each paid tool
states its current price in its description.

`image_palette` and `brand_from_url` appear once Bacon's catalog publishes them with contract
versions. A service the installed package doesn't understand is listed by `list_services` but
can't be called until you update the package.

Free tools:

- `list_services`: everything Bacon sells right now, with prices, limits, and whether this
  version of the package can run it.
- `quote`: Bacon's current price for one service, and whether your limits and wallet allow it.
  Nothing is signed.
- `wallet_status`: network, whether a wallet is configured, your limits and what's left of them,
  and whether you can afford each service (yes/no).

## Before you start

1. **Node.js 20 or newer.**
2. **A dedicated wallet** holding only what you're willing to spend. Fund it with **USDC on Base**.
   You don't need ETH: x402 payments are signed authorizations (EIP-3009), and the facilitator
   pays the gas.
3. **Put the private key in a file** that only you can read, for example `~/.bacon/buyer.key`.
   Pointing `BACON_WALLET_KEY_FILE` at that file keeps the key out of MCP host configs, which are
   often synced or shared. `BACON_WALLET_PRIVATE_KEY` also works.

The key never leaves your machine. Only signatures are sent, and only to Bacon. The key is never
logged, never written to the spend ledger, and never accepted as a tool argument.

## Install

### Claude Code

```bash
claude mcp add bacon -e BACON_WALLET_KEY_FILE=/home/you/.bacon/buyer.key -- npx -y baconservices-mcp
```

Add more `-e NAME=value` pairs for the limits below. Check it with `claude mcp list`.

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bacon": {
      "command": "npx",
      "args": ["-y", "baconservices-mcp"],
      "env": {
        "BACON_WALLET_KEY_FILE": "/Users/you/.bacon/buyer.key",
        "BACON_MAX_PER_CALL": "0.50",
        "BACON_MAX_PER_SESSION": "1.00",
        "BACON_MAX_PER_DAY": "5.00"
      }
    }
  }
}
```

On Windows, if `npx` isn't found, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "baconservices-mcp"]`, and write paths as
`"C:\\Users\\you\\.bacon\\buyer.key"`. Restart Claude Desktop afterwards.

### Cursor, Windsurf and other clients with an `mcpServers` file

Use the same `command` / `args` / `env` block as Claude Desktop (for Cursor:
`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project).

### VS Code (`.vscode/mcp.json`)

VS Code can prompt for the key once and store it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "bacon-key", "description": "Bacon buyer wallet private key", "password": true }
  ],
  "servers": {
    "bacon": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "baconservices-mcp"],
      "env": { "BACON_WALLET_PRIVATE_KEY": "${input:bacon-key}" }
    }
  }
}
```

### Any other MCP client

It's a stdio server: run `npx -y baconservices-mcp` with the environment below.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BACON_WALLET_KEY_FILE` | — | Path to a file containing the buyer wallet's private key. |
| `BACON_WALLET_PRIVATE_KEY` | — | The key itself (set only one of the two). Without either, the free tools still work. |
| `BACON_MAX_PER_CALL` | `0.50` | Largest single payment, in USDC. |
| `BACON_MAX_PER_SESSION` | `1.00` | Most this server process may spend. |
| `BACON_MAX_PER_DAY` | `5.00` | Most spent in any rolling 24 hours, across all processes and restarts. |
| `BACON_CONFIRM` | `auto` | `auto`: ask before each payment when the host can; `always`: refuse to pay when it can't; `never`: don't ask (for unattended agents; the limits still apply). |
| `BACON_NETWORK` | `base` | `base` (real USDC, baconservices.com) or `base-sepolia` (test USDC, a test copy of Bacon). |
| `BACON_API_URL` | — | Only with `base-sepolia`: the test copy's address. |
| `BACON_PAY_TO` | — | Only with `base-sepolia`: the test copy's receiving address. |
| `BACON_RPC_URL` | `https://mainnet.base.org` | RPC used to check your USDC balance before paying. |
| `BACON_LEDGER_DIR` | `~/.baconservices-mcp` | Where the spend ledger lives. |
| `BACON_DISCLOSE_BALANCE` | `false` | `true` adds the exact balance and the wallet address to `wallet_status`. |

## How your money is protected

All of these checks happen before anything is signed:

- **The price is Bacon's own.** Bacon answers each request with an x402 402 that names the price.
  The server pays only if that price equals Bacon's live catalog price, for that exact endpoint,
  in Base USDC, to Bacon's receiving address (which is pinned in the package). If any of these
  can't be verified, it doesn't pay.
- **Your limits.** It checks the per-call limit, an optional `max_price_usdc` on the call, the
  per-session limit, and the 24-hour limit. The 24-hour total is kept in a local ledger file
  shared by every process, so restarting the MCP server or running it twice doesn't open a new
  budget. If the ledger can't be read, nothing is paid. The x402 library's own per-payment
  cap is set to your per-call limit as a second lock.
- **Funds.** It reads your USDC balance first. If it's too low, or the balance can't be read,
  you get a plain message and nothing is signed.
- **Your approval, where possible.** If the MCP host supports it, you're asked *"Pay 0.2 USDC on
  Base to Bacon Services to run remove_background?"* Not every host can ask, so the limits are
  the real boundary.
- **No double payments.** Each purchase signs one payment for one request. If the connection drops,
  the server resends that same signed payment once (Bacon answers a repeat with the same result)
  and never signs a new one. Asking for the same thing again within 10 minutes returns the
  earlier result for free, unless you pass `allow_repeat: true`.
- **Only known services run.** New services in Bacon's catalog show up in `list_services`. They
  become callable tools only once a version of this package that understands their contract
  (inputs, outputs, version) is installed.

If Bacon refuses a payment before taking it, the result says *"You have not been charged"* and
the amount goes back to your limits. If the outcome is unknown (for example the connection was lost
twice), the result says so and gives Bacon's request id. That amount keeps counting against your
limits.

## Test money

Production Bacon sells only for real USDC. To try things without real money, run against a local
or test copy of Bacon that sells on Base Sepolia:

```bash
BACON_NETWORK=base-sepolia BACON_API_URL=http://127.0.0.1:8000 BACON_PAY_TO=0xYourTestPayTo npx -y baconservices-mcp
```

The package refuses mismatched setups and pays nothing in each case: test money pointed at
baconservices.com, real money pointed anywhere else, or a Bacon whose catalog is on a different
network.

## Develop

```bash
npm install
npm test
```

The tests run against a fake Bacon that checks every payment signature for real. Nothing reaches
a network.

## License

MIT
