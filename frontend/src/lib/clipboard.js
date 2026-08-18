import { Capacitor } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'

export async function readClipboardText() {
  if (Capacitor.isNativePlatform()) {
    const result = await Clipboard.read()
    return result.value || ''
  }

  if (!navigator.clipboard?.readText) {
    throw new Error('CLIPBOARD_UNAVAILABLE')
  }

  return navigator.clipboard.readText()
}

export async function writeClipboardText(text) {
  if (Capacitor.isNativePlatform()) {
    await Clipboard.write({ string: text })
    return
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error('CLIPBOARD_UNAVAILABLE')
  }

  await navigator.clipboard.writeText(text)
}
