// Tags <html data-platform="darwin|win32|linux|other"> so styles can vary per OS.
const platform = typeof window !== 'undefined' && typeof window.bridge !== 'undefined'
  ? window.bridge.getPlatform()
  : 'other'

const tag = platform === 'darwin' ? 'darwin'
  : platform === 'win32' ? 'win32'
  : platform === 'linux' ? 'linux'
  : 'other'

document.documentElement.dataset.platform = tag
