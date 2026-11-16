# Developer Guide

This page consolidates everything needed to integrate a dApp with BeetVault. It assumes you have a transaction ready to sign and want the user to approve it in their wallet.

## Choosing an Input Method

BeetVault accepts transaction requests through three channels. Pick based on transaction size and user workflow:

| Method | Capacity | Best for |
|--------|----------|----------|
| [JSON File](./deeplinks/json-file/overview.md) | 10 MB | Default choice; large batches, offline workflows |
| [QR Code](./deeplinks/qr/overview.md) | ~1,000 bytes recommended | Air-gapped or cross-device signing |
| [Raw Deeplink](./deeplinks/raw/overview.md) | ~2,048-character URL in practice (wallet cap: 4,096 after `rawbeetvault://api/`) | One-click requests from a dApp on the same machine |

> **Only `rawbeetvault://`.** BeetVault does not handle `beetvault://`, `beeteos://` or `rawbeeteos://` links, so it cannot take links meant for other Beet-family wallets. Raw deeplinks are only processed while the user has the **Raw Deeplink** page open with an unlocked wallet.

## The Request Envelope

JSON files and raw deeplinks wrap the transaction in this envelope:

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

| Field | Required | Notes |
|-------|----------|-------|
| `type` | Yes | Always `"api"` |
| `id` | Yes | Any non-empty string; UUID v4 recommended |
| `payload.method` | Yes | Usually `"injectedCall"` |
| `payload.params` | Yes | `[action, stringifiedTx, []]` |
| `payload.chain` | Yes | Must match the wallet's active chain |
| `payload.encoding` | No | `"json"` (default) or `"esr"` for ESR-encoded Antelope requests |
| `payload.appName` | No | Shown in the approval prompt |
| `payload.browser` | No | Shown in the approval prompt |
| `payload.origin` | No | Shown in the approval prompt |

**QR codes are the exception** — they carry a bare transaction object with no envelope. The wallet constructs the envelope itself after scanning. See [QR Code](./deeplinks/qr/overview.md) for the per-chain shapes.

## Encoding Pipelines

Each method encodes the same envelope differently:

| Method | Pipeline |
|--------|----------|
| JSON File | `JSON.stringify` |
| Raw deeplink | `"rawbeetvault://api/?request=" + encodeURIComponent(JSON.stringify(envelope))` |
| QR Code | `JSON.stringify` of the bare transaction object (or ESR string) |

For **Antelope chains**, three encoding options are available for `params[1]`:

| Encoding | `params[1]` content | `payload.encoding` | Benefits |
|----------|---------------------|-------------------|----------|
| ESR | Base64url ESR binary (`esr://...`) | `"esr"` | Fresh TAPOS, placeholders, smaller payload |
| JSON (full) | Stringified transaction with TAPOS + hex data | omitted | Full dApp control |
| JSON (null) | Stringified `{actions}` with placeholder auth | omitted | No chain access needed, signer-agnostic |

See the [Antelope JSON File](./deeplinks/json-file/antelope.md) page for encoding examples.

## Worked Example

The same BitShares transfer, delivered three ways.

### 1. Build the transaction

```js
import { v4 as uuidv4 } from "uuid";
import TransactionBuilder from "./bts/chain/TransactionBuilder";

async function buildTransaction(opTypes, operations) {
  const tr = new TransactionBuilder();

  for (let i = 0; i < operations.length; i++) {
    const op = { ...operations[i] };

    // Memo messages must be bytes, not strings
    if (op.memo && typeof op.memo.message === "string") {
      op.memo.message = Buffer.from(op.memo.message, "utf-8");
    }

    tr.add_type_operation(opTypes[i], op);
  }

  await tr.update_head_block();
  await tr.set_required_fees();
  tr.set_expire_seconds(7200);
  tr.finalize();

  return tr;
}
```

### 2. Wrap it in the envelope

```js
function buildEnvelope(chain, tr) {
  return {
    type: "api",
    id: uuidv4(),
    payload: {
      method: "injectedCall",
      params: ["signAndBroadcast", JSON.stringify(tr.toObject()), []],
      appName: "My dApp",
      chain: chain,
      browser: "web browser",
      origin: "app.example",
    },
  };
}
```

### 3. Emit each format

```js
import { writeFileSync } from "fs";

const tr = await buildTransaction(["transfer"], [transferOp]);
const envelope = buildEnvelope("BTS", tr);
const json = JSON.stringify(envelope);

// JSON file (data URI for browser download)
const fileHref = `data:text/json;charset=utf-8,${encodeURIComponent(json)}`;

// JSON file (written from a script or CLI tool)
writeFileSync("transaction.json", json);

// Raw deeplink (same envelope, URL-encoded)
const rawUrl = `rawbeetvault://api/?request=${encodeURIComponent(json)}`;

// QR code — bare transaction object, no envelope
const qrValue = JSON.stringify(tr.toObject());
```

## Chain Differences

### Graphene (BitShares)

- Transactions are built with `TransactionBuilder` and serialized via `toObject()`
- Operations are `[opTypeId, opPayload]` pairs, where `opTypeId` is numeric
- QR codes carry the full transaction object including `operations`
- Authorization is matched against the numeric operation type

### Antelope (Vaulta, WAX, Telos, FIO, Libre, XPR) and Hive

- Transactions are built with chain-specific tooling such as `@wharfkit/antelope`
- Operations are actions carrying a string `name`
- QR codes carry an object with an `actions` array
- Authorization is matched against each action's `name`
- Antelope supports optional ESR encoding (`payload.encoding: "esr"`) for smaller payloads, fresh TAPOS, and null-user flows

The request envelope is identical across all chains — only transaction construction and the QR payload shape differ.

## Common Pitfalls

**Chain mismatch.** If `payload.chain` does not match the chain the wallet currently has selected, the request is rejected before the user sees a prompt. The wallet's notification says the file is for a different chain.

**Operation outside permission scope.** Users configure which operation types a page may authorize. If no operation in the transaction is within that scope, the request is rejected and the notification says so. Have the user re-check their scope selection.

**Memo message as string.** Graphene memo messages must be converted to bytes with `Buffer.from(message, "utf-8")` before being added to the transaction. Passing a raw string produces a malformed transaction.

**Wrong page open.** Raw deeplinks are only processed while the **Raw Deeplink** page is open, its scope is saved and the wallet is unlocked. Anywhere else, the wallet shows a notification asking the user to open that page.

**URL too long.** Chromium-based browsers silently discard URLs beyond roughly 2,048 characters, so the link does nothing. BeetVault also rejects links with more than 4,096 characters after `rawbeetvault://api/`. Measure before shipping and fall back to a file download.

**URL-encoded file contents.** Write the envelope as plain JSON. A file containing `%7B...` instead of `{...` is rejected as invalid JSON.

## Graceful Degradation

Measure each payload and hide any method that cannot carry the transaction:

```js
const canUseDeeplink = rawUrl.length < 2048;

const qrLength = JSON.stringify(tr.toObject()).length;
const canUseQR = qrLength < 1200;
```

Then render conditionally, keeping the file download always available:

```jsx
{canUseDeeplink && <DeeplinkButton href={rawUrl} />}
{canUseQR && <QRCodeTab value={qrValue} />}
<DownloadButton href={fileHref} />   {/* always available */}
```

## Testing Checklist

- Transaction broadcasts successfully through each method you offer
- Chain identifier matches what the wallet expects for your target network
- Longest realistic transaction still fits within the QR limit, if you offer QR
- Longest realistic transaction still fits within the deeplink URL limit, if you offer raw links
- Raw links arriving while the Raw Deeplink page is closed show the user where to go
- Oversized transactions degrade to file download rather than failing silently
- Memo-carrying operations encode correctly
