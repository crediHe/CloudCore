/**
 * Native（node-addon）模块动态加载器。
 *
 * 渲染进程已开启 nodeIntegration（WindowManager webPreferences，2026-09 性能优先
 * 决策）：.node 产物可直接在本进程 require，C++ 算法贴 three.js 缓冲零拷贝计算。
 * 产物绝对路径随 dev / 打包后环境而异，由主进程统一解析（'native:get-module-path'，
 * 见 nativeModulePlugin）后经 IPC 下发。
 *
 * 动态加载必须用 Function 构造器求值 require：静态 import / require 会被
 * Vite/Rollup 的静态分析识别并尝试打包 .node（无对应 loader 会直接构建失败）。
 * index.html 无 CSP、无 eval 限制，该写法可行。
 */

/** 渲染进程的 Node 版 require（nodeIntegration 开启后存在于全局作用域）。 */
type RendererRequire = (modulePath: string) => unknown

/** 模块级缓存：同一 .node 只加载一次（dlopen 有开销，且模块带全局状态）。 */
const moduleCache = new Map<string, unknown>()

/**
 * 加载指定名称的 native 模块（首次经 IPC 取路径后 require，此后走缓存）。
 * @param name 模块名（与 nativeModulePlugin 的 MODULE_RELATIVE_PATHS 键一致，如 'radius_filter'）
 * @returns 模块导出对象（具体导出类型由调用方按模块契约自行声明）
 */
export async function loadNativeModule<T = unknown>(name: string): Promise<T> {
  const cached = moduleCache.get(name)
  if (cached !== undefined) return cached as T

  const info = await window.electronAPI.native.getModulePath(name)
  if (!info.path || !info.exists) {
    throw new Error(
      `native 模块「${name}」产物不存在：${info.path || '（未知路径）'}\n` +
        '请确认已执行 pnpm build:native 完成 C++ 编译（需要 VS Build Tools 与系统 Python）。'
    )
  }
  // 注意：静态 require 会被 Vite 打包拦截，必须经 Function 构造器动态求值（见文件头注释）
  const requireFn = new Function('p', 'return require(p)') as RendererRequire
  const mod = requireFn(info.path)
  moduleCache.set(name, mod)
  return mod as T
}
