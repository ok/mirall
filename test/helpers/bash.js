// The shell the repository's scripts run under, for a test that spawns one. On Windows a bare
// `bash` can resolve to the WSL launcher, which reads no Windows path, so the bash that Git for
// Windows installs is named outright where it exists.
import { existsSync } from 'node:fs'
import path from 'node:path'

function gitForWindowsBash() {
  const exe = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  return existsSync(exe) ? exe : 'bash'
}

export const BASH = process.platform === 'win32' ? gitForWindowsBash() : 'bash'

// A script path as bash reads it: forward slashes on every system, since a backslash is an escape
// to the shell and to the tools a script hands the path on to.
export const shellPath = (p) => p.split(path.sep).join('/')
