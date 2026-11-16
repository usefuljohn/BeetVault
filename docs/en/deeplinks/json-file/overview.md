# JSON File

The JSON File method lets you load transaction payloads from files and submit them to the wallet for processing. This is useful for workflows where dApps export transaction requests as files.

> **Recommended for most integrations.** Unlike QR codes, file uploads are not constrained by scanning limits. Files up to 10 MB are accepted, which covers thousands of operations.

## How It Works

A dApp exports a transaction payload as a file. You upload the file to BeetVault, which reads the content, parses it as JSON, validates it against your permission scope, and prompts you to approve or deny the operation.

## Setup

1. Navigate to **JSON File** in the main menu
2. Select the account that will sign the transaction
3. Configure which blockchain operations are permitted

## Permission Scopes

Before uploading files, configure what operations are allowed:

- **Yes - customize scope** — Select specific operation types to permit (recommended)
- **No - allow all operations** — Allow any operation type (less restrictive)

## Uploading a File

1. Click the upload button and select a file from your filesystem
2. BeetVault reads the file contents as text
3. The content is parsed as JSON
4. The wallet verifies the chain, request format and that at least one operation is within your configured scope
5. If permitted, a prompt appears with the operation details
6. Review and approve or deny the transaction

If the file is rejected, the notification states why — for example invalid JSON, a chain mismatch, or operations outside your scope. You can re-select the same file name after regenerating it.

## File Format

The file contains a request envelope stored as plain JSON. Do not URL-encode it:

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
| `id` | Yes | Unique request identifier (UUID v4 recommended) |
| `payload.method` | Yes | Request method — typically `"injectedCall"` |
| `payload.params` | Yes | For `injectedCall`: `[action, stringifiedTx, []]` |
| `payload.chain` | Yes | **Must match the wallet's currently selected chain** |
| `payload.encoding` | No | `"json"` (default) or `"esr"` for ESR-encoded Antelope requests |
| `payload.appName` | No | Display name shown in the approval prompt |
| `payload.browser` | No | Origin browser, shown in the prompt |
| `payload.origin` | No | Requesting domain, shown in the prompt |

> **Chain must match.** If `payload.chain` differs from the chain the wallet currently has selected, the file is rejected before the user sees a prompt.

## Generating a File

In a browser, offer it as a download via a data URI:

```jsx
const request = {
  type: "api",
  id: uuidv4(),
  payload: {
    method: "injectedCall",
    params: ["signAndBroadcast", JSON.stringify(tr.toObject()), []],
    appName: "My dApp",
    chain: "BTS",
    browser: "web browser",
    origin: "app.example",
  },
};

const encoded = encodeURIComponent(JSON.stringify(request));

<a href={`data:text/json;charset=utf-8,${encoded}`}
   download="transaction.json">
  Download transaction file
</a>
```

From a script or CLI tool, write the JSON directly:

```js
import { writeFileSync } from "fs";

writeFileSync("transaction.json", JSON.stringify(request, null, 2));
```

## When to Use This Method

File uploads are the right choice whenever a transaction is too large for a QR code:

| Method | Practical size limit | Constraint |
|--------|---------------------|------------|
| QR Code | ~1,000 bytes recommended | QR image data capacity and scan reliability |
| **JSON File** | **10 MB** | Upload size cap |

Transactions containing hundreds or thousands of operations should always use file upload.

## Chain Compatibility

JSON file processing is supported on **all chains**, including Hive.

## Code Examples by Chain Family

For complete, chain-specific code examples showing how to build transactions and generate JSON files:

- [BTS / Graphene](./bts.md) — BitShares and other Graphene-based chains
- [Antelope](./antelope.md) — Vaulta, WAX, Telos, FIO, Libre, XPR Network, BEOS
- [Hive](./hive.md) — Hive mainnet
