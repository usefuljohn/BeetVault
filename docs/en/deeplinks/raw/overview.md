# Raw Deeplink

The Raw Deeplink method processes incoming `rawbeetvault://api/` protocol requests from dApps. Raw deeplinks carry an unencrypted, URL-encoded request envelope directly to the wallet for signing.

> **Only `rawbeetvault://`.** BeetVault does not handle `beetvault://`, `beeteos://` or `rawbeeteos://` links. Earlier versions registered those schemes too, which could take links away from other Beet-family wallets; current versions release any such registration on launch.

## How It Works

A dApp constructs a transaction and sends it to BeetVault via the `rawbeetvault://api/` protocol. The payload is URL-encoded JSON — no encryption or passcode is required. BeetVault receives the payload, parses it, validates it against your permission scope, and prompts you to approve or deny the operation.

## Setup

1. Navigate to **Raw Deeplink** in the main menu
2. Select the account that will sign incoming requests
3. Configure which blockchain operations are permitted, then keep the page open

## Permission Scopes

Before the wallet can process raw deeplinks, you must set the allowed operations:

- **Yes - customize scope** — Select specific operation types to permit (recommended)
- **No - allow all operations** — Allow any operation type (less restrictive)

## Processing a Raw Deeplink

When a dApp sends a `rawbeetvault://api/` request:

1. The wallet receives the link and checks it starts with `rawbeetvault://api/` and is no longer than 4,096 characters after that prefix
2. It parses the query string and reads the `request` parameter
3. The payload is URL-decoded (links encoded twice are decoded again) and parsed as JSON
4. The wallet validates the request against your permission scope
5. If permitted, a prompt appears showing the operation details
6. Review and approve or deny the transaction

> **Note:** The wallet must be unlocked, the Raw Deeplink page must be open and its scope saved. A link that arrives anywhere else is rejected with a notification asking you to open the Raw Deeplink page. Only one link is processed at a time.

## Deeplink URL Format

A raw deeplink has the following structure:

```
rawbeetvault://api/?request=<url_encoded_json>
```

| Query parameter | Description |
|-----------------|-------------|
| `request` | URL-encoded JSON request envelope |

The chain is taken from `payload.chain` inside the envelope. Older examples that also pass `chain=` still work; the parameter is ignored.

## Request Envelope

The `request` parameter contains a URL-encoded JSON object with this structure:

```json
{
  "type": "api",
  "id": "3f9a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b",
  "payload": {
    "method": "injectedCall",
    "params": ["signAndBroadcast", "<stringified transaction>", []],
    "appName": "My dApp",
    "chain": "BTS",
    "browser": "web browser",
    "origin": "app.example"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Always `"api"` |
| `id` | Yes | Your request identifier. Any non-empty string; the wallet uses its own internal id for the approval prompt |
| `payload.method` | Yes | Request method — typically `"injectedCall"` |
| `payload.params` | Yes | For `injectedCall`: `[action, stringifiedTx, []]` |
| `payload.chain` | Yes | **Must match the wallet's currently selected chain** |
| `payload.encoding` | No | `"json"` (default) or `"esr"` for ESR-encoded requests |
| `payload.appName` | No | Display name shown in the approval prompt |
| `payload.browser` | No | Origin browser, shown in the prompt |
| `payload.origin` | No | Requesting domain, shown in the prompt |

> **Chain must match.** If `payload.chain` differs from the chain the wallet currently has selected, the request is rejected before the user sees a prompt.

## Generating a Raw Deeplink

The envelope is identical across all chains — only the transaction construction inside `params` differs. Build the transaction using your chain's own tooling, stringify it into `payload.params`, and set `payload.chain` to the matching identifier.

```js
import { v4 as uuidv4 } from "uuid";

function buildRawDeeplink(chain, transactionObject) {
  const request = {
    type: "api",
    id: uuidv4(),
    payload: {
      method: "injectedCall",
      params: ["signAndBroadcast", JSON.stringify(transactionObject), []],
      appName: "My dApp",
      chain: chain,
      browser: "web browser",
      origin: "app.example",
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(request));
  return `rawbeetvault://api/?request=${encoded}`;
}
```

Render the result as a normal link — the OS hands it to BeetVault:

```html
<a href="rawbeetvault://api/?request=...">Broadcast with BeetVault</a>
```

## URL Length Limit

> **For dApp developers:** Keep the complete deeplink URL under **2,048 characters**. BeetVault itself rejects links with more than 4,096 characters after `rawbeetvault://api/`, but browsers usually fail first.

Chromium-based browsers (Chrome, Edge, Brave, Opera) enforce a practical URL length ceiling around 2,048 characters. Safari and Firefox permit longer URLs, but assume 2,048 is the hard limit for cross-browser reliability — links exceeding it will silently fail to launch the wallet.

This limit applies to the **entire URL**, including the `rawbeetvault://api/?request=` prefix and all URL encoding overhead.

URL encoding roughly doubles the JSON payload size, because the stringified transaction nested inside `params` contains many quotes and braces that each expand to three characters.

### Measured capacity

Simple BitShares transfer operations, measured end to end:

| Operations | JSON payload | Final URL | Fits? |
|-----------:|-------------:|----------:|:------|
| 1 | 377 | 701 | Yes |
| 3 | 673 | 1,281 | Yes |
| 5 | 969 | 1,861 | Yes |
| 8 | 1,413 | 2,731 | No |

Roughly **5–6 simple operations** is the practical ceiling. Operations carrying memos or long strings consume the budget faster — always measure your own longest expected transaction.

### Exceeding the limit

If your transaction cannot fit — for example, a batch containing hundreds or thousands of operations — use the [JSON File](../json-file/overview.md) method instead. It takes the same envelope as plain JSON, up to 10 MB.

## Security Considerations

- Raw deeplinks send unencrypted transaction data — only use with trusted dApps
- Configure the operation scope to limit what can be authorized
- Always review the full transaction details in the prompt before approving
- The payload is URL-encoded — ensure your dApp properly encodes all special characters

## Chain Compatibility

Raw deeplinks are supported on **all chains**, including Hive.

## Code Examples by Chain Family

For complete, chain-specific code examples showing how to build transactions and generate raw deeplinks:

- [BTS / Graphene](./bts.md) — BitShares and other Graphene-based chains
- [Antelope](./antelope.md) — Vaulta, WAX, Telos, FIO, Libre, XPR Network, BEOS
- [Hive](./hive.md) — Hive mainnet
