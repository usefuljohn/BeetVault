# Features

BeetVault provides a comprehensive set of features for managing your blockchain assets.

## Transaction Operations

BeetVault supports signing and broadcasting transactions across all supported blockchains:

- **Transfers** — Send tokens to other accounts
- **Votes** — Cast governance votes for witnesses, committee members, or workers
- **Staking** — Stake tokens for power or voting weight
- **Custom Operations** — Sign arbitrary contract operations

## Multiple Authorization Methods

Interact with BeetVault in multiple ways:

### JSON Files
Upload a JSON file containing a transaction request from a dApp or tool. Files are accepted up to 10 MB and have no URL length limit, so they suit large batches of operations.

### Raw Deeplinks
Open a `rawbeetvault://api/?request=...` link from a dApp while the **Raw Deeplink** page is open and the wallet is unlocked. The request goes through the same scope check and approval prompt as a JSON file. Browsers usually drop links over about 2,048 characters (the wallet's own cap is 4,096), so use a JSON file for anything larger. See [Raw Deeplink](./deeplinks/raw/overview.md).

BeetVault only registers `rawbeetvault://`. The `beetvault://`, `beeteos://` and `rawbeeteos://` schemes are not handled, so BeetVault cannot take links away from other Beet-family wallets.

### QR Codes
Scan QR codes containing transaction payloads for air-gapped signing workflows.

### Injected Calls
Web applications can request transaction signing through BeetVault's injected provider interface.

### Raw Transactions
Manually construct and sign raw transaction JSON through the JSON File and Raw Deeplink screens.

> **Note for dApp developers:** QR codes are constrained by image data capacity and scan reliability. For large transactions, use the [JSON File](./deeplinks/json-file/overview.md) method.

> **Chain support:** All input methods work on every supported chain, including Hive. See [Blockchains](./blockchains.md).

## Security Features

- **Local key storage** — Private keys never leave your device
- **Password encryption** — All wallet data is encrypted with your password using Argon2id + AES-256-GCM
- **Session timeout** — Automatic logout after configurable inactivity periods
- **Sandboxed execution** — Renderer process is isolated from system APIs

## Backup & Restore

- **Encrypted backups** — Export your entire wallet as an encrypted `.beet` file
- **Restore anywhere** — Import backups on any BeetVault instance with your password
- **Selective restore** — Choose which accounts to restore from a backup

## Multi-Account Management

- Manage accounts across multiple blockchains simultaneously
- Switch between accounts quickly from the dashboard
- Per-account permission management

## Network Configuration

- Custom node configuration per blockchain
- Switch between predefined and custom RPC endpoints
- Network health indicators
