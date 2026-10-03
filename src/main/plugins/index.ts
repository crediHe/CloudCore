/**
 * 主进程内置插件统一导出。
 *
 * 新增插件后，请在此处导出并在 `src/main/main.ts` 中按顺序注册。
 */
export { loggerPlugin } from './loggerPlugin'
export { robustnessPlugin } from './robustnessPlugin'
export { crossWindowBridgePlugin } from './crossWindowBridgePlugin'
export { dialogPlugin } from './dialogPlugin'
export { updatePlugin } from './updatePlugin'
export { storePlugin } from './storePlugin'
export { notificationPlugin } from './notificationPlugin'
export { windowControlPlugin } from './windowControlPlugin'
export { windowManagerPlugin } from './windowManagerPlugin'
export { shortcutPlugin } from './shortcutPlugin'
export { trayPlugin } from './trayPlugin'
export { menuPlugin } from './menuPlugin'
export { plyPlugin } from './plyPlugin'
export { lasPlugin } from './lasPlugin'
export { pointCloudSavePlugin } from './pointCloudSavePlugin'
export { nativeModulePlugin } from './nativeModulePlugin'
