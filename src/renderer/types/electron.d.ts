import type { CrossWindowMessage } from '../../shared/types/window'
import type { ElectronAPI, ElectronEvents } from '../../shared/types/electron-api'

declare global {
  interface Window {
    electronAPI: ElectronAPI
    electronEvents: ElectronEvents
  }
}

export { CrossWindowMessage }
