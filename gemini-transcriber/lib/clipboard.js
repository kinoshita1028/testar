// Copy text to the clipboard. When this page has focus the normal API works;
// otherwise (auto-copy while you type elsewhere) the background worker copies
// through an offscreen document.

export async function copyText(text) {
  if (!text) return false;

  if (document.hasFocus()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
    if (legacyCopy(text)) return true;
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'copy-text', text });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

function legacyCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
