# Troubleshooting

Common issues and their solutions.

## Wallet Won't Unlock

**Problem:** BeetVault rejects your password.

**Solutions:**
- Verify Caps Lock is off
- Check that you're using the password for this specific wallet (not a different backup)
- If you recently restored from backup, ensure you used the original wallet's password

## Transaction Fails to Broadcast

**Problem:** Signed transaction returns an error or times out.

**Solutions:**
- Check your internet connection
- Verify the blockchain node is responding (try switching to a different node)
- Ensure your account has sufficient balance for the operation + fees
- Check that your account has the required authority (active/owner) for the operation

## Node Connection Issues

**Problem:** BeetVault cannot connect to the blockchain.

**Solutions:**
1. Open **Settings → Change Nodes**
2. Try a different node from the dropdown
3. If all nodes fail, check your firewall/proxy settings
4. Test the node URL in a browser (it should return JSON data)

## Modal Window Doesn't Appear

**Problem:** Uploading a JSON file or scanning a QR code doesn't show the transaction prompt.

**Solutions:**
- Ensure BeetVault is fully unlocked (not on the lock screen)
- Check that no other modal is already open
- Check that the file's `payload.chain` matches the chain currently selected in the wallet
- Check that the operations in the transaction are within the scope you selected
- Restart BeetVault and try again

## Protocol Links Don't Open BeetVault

**Problem:** A protocol link does nothing, opens a different wallet, or shows "A Raw deeplink was rejected".

**Solutions:**
- BeetVault only handles `rawbeetvault://` links. `beetvault://`, `beeteos://` and `rawbeeteos://` links are left to other Beet-family wallets; ask the dApp for a `rawbeetvault://` link or a [JSON File](./deeplinks/json-file/overview.md)
- Unlock the wallet and open **Raw Deeplink** from the main menu, choose a scope, and then open the link again
- Check that the request's `payload.chain` matches the selected account's chain and that its operations are within the chosen scope
- Links longer than 4,096 characters are rejected; use a JSON file for large transactions

## QR Code Won't Scan

**Problem:** The camera cannot read the QR code, or scanning produces no result.

**Solutions:**
- **Try the drag or upload methods instead.** These read the QR from an image file rather than a camera, bypassing optical scanning limits entirely — often the fastest fix.
- The code may be too dense — large payloads produce high-version QR codes with fine module patterns that cameras struggle to resolve
- Improve lighting, reduce screen glare, and hold the camera steady at the right distance
- Display the code larger on the source screen, if possible
- Ask the dApp to use the [JSON File](./deeplinks/json-file/overview.md) method for large transactions

## Backup/Restore Failures

**Problem:** Cannot create or restore a backup file.

**Solutions:**
- Verify you have write permissions to the backup location
- Ensure you're using the correct password for the backup file
- Check that the file wasn't corrupted during transfer
- Try downloading the backup signature again (requires internet)

## Error Windows

If BeetVault encounters an error:

1. An error window will appear with details
2. Use the **Copy** button to save error details
3. Include these details when seeking support
4. The error window persists even if you log out — you can close it anytime

## Still Need Help?

If your issue isn't listed here:

- Search the [FAQ](./faq.md)
- Check existing GitHub issues
- Open a new GitHub issue with:
  - BeetVault version
  - Operating system
  - Steps to reproduce
  - Error window details (if any)
