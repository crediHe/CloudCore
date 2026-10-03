export type AppMode = 'development' | 'production' | 'test'

export interface AppEnv {
  /** 后端服务的基础 API URL。 */
  API_URL: string
  /** 崩溃报告可选的 Sentry DSN。 */
  SENTRY_DSN?: string
  /** electron-updater 可选的通用更新服务器 URL。 */
  UPDATE_URL?: string
  /** 当前构建模式。 */
  MODE: AppMode
}

function detectMode(): AppMode {
  const nodeEnv = process.env.NODE_ENV
  if (nodeEnv === 'development' || nodeEnv === 'production' || nodeEnv === 'test') {
    return nodeEnv
  }
  // Electron 生产构建可能不会设置 NODE_ENV，回退到 production。
  return 'production'
}

/** AppMode 允许的值，用于运行时校验。 */
const ALLOWED_MODES: readonly AppMode[] = ['development', 'production', 'test']

/**
 * 运行时校验并规范化构建模式。
 * 若 metaEnv.MODE 不在允许值范围内，回退到传入的 mode 参数。
 */
function validateAppMode(raw: unknown, fallback: AppMode): AppMode {
  if (typeof raw === 'string' && (ALLOWED_MODES as readonly string[]).includes(raw)) {
    return raw as AppMode
  }
  return fallback
}

/**
 * 主进程应用环境。
 *
 * Vite 在构建时加载 `.env.development` / `.env.production`，
 * 并通过 `import.meta.env` 暴露前缀为 `VITE_` 或 `MAIN_VITE_` 的变量。
 * 具体配置见 `vite.config.ts` 中的 `envPrefix`。
 */
export function loadAppEnv(mode: AppMode = detectMode()): AppEnv {
  const metaEnv = import.meta.env

  return {
    API_URL: metaEnv.MAIN_VITE_API_URL || metaEnv.VITE_API_URL || '',
    SENTRY_DSN: metaEnv.MAIN_VITE_SENTRY_DSN || metaEnv.VITE_SENTRY_DSN || undefined,
    UPDATE_URL: metaEnv.MAIN_VITE_UPDATE_URL || metaEnv.VITE_UPDATE_URL || undefined,
    MODE: validateAppMode(metaEnv.MODE, mode),
  }
}

/**
 * 主进程应用环境单例。
 * 所有主进程模块（WindowManager、HTTP 客户端、崩溃报告器等）在需要配置值时导入此对象。
 */
export const appEnv = loadAppEnv()
