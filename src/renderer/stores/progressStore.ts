import { reactive } from 'vue'

/**
 * 全局进度条任务状态（模块级单例，与 consoleStore 同模式）。
 *
 * 通用进度条模块：任何长任务（加载点云、导出等）通过 start() 启动一个任务，
 * 由 GlobalProgress.vue 渲染。同时只展示一个活跃任务，其余排队（FIFO），
 * 活跃任务结束后自动轮到下一个。
 *
 * 任务字段按需声明，未声明的特性不渲染：
 * - progress: null 表示不确定进度（如文件扫描阶段），显示循环动画
 * - modal: true 时遮幕禁止点击（加载点云等"会改变场景状态"的任务应开）
 * - cancellable + onCancel: 提供真正的取消逻辑才声明，否则不显示取消按钮
 * - title / message / detail: 可选文字，不填则不渲染
 */

export type ProgressStatus = 'queued' | 'active' | 'done' | 'failed' | 'cancelled'

export interface ProgressTaskOptions {
  /** 任务标题（可选，不填不渲染）。 */
  title?: string
  /** 阶段消息（可选，随进度更新）。 */
  message?: string
  /** 可选明细行。 */
  detail?: string
  /** 进度 0-100；null = 不确定进度（循环动画）。默认 null。 */
  progress?: number | null
  /** 是否遮幕禁止点击，默认 false。 */
  modal?: boolean
  /** 是否显示取消按钮，默认 false；需同时提供 onCancel。 */
  cancellable?: boolean
  /** 真正的取消逻辑（清理资源、中止循环等）。 */
  onCancel?: () => void | Promise<void>
}

/** 内部任务记录（含生命周期状态）。progress 由 start() 统一初始化为 null。 */
export interface ProgressTask extends ProgressTaskOptions {
  id: number
  /** 进度 0-100；null = 不确定进度。 */
  progress: number | null
  status: ProgressStatus
}

/** 面向调用方的任务句柄：只操作自己的任务，不会互相覆盖。 */
export interface ProgressTaskHandle {
  readonly id: number
  /** 更新进度与消息；progress 传 null 表示切回不确定进度。 */
  update(progress: number | null, message?: string, detail?: string): void
  /** 正常结束：进度条短暂停留后自动关闭。 */
  done(): void
  /** 失败：进度条转红并停留，由用户点击"关闭"。 */
  fail(message?: string): void
  /** 主动取消（仅 cancellable 任务生效，触发 onCancel 后关闭）。 */
  cancel(): void
}

/** done / cancelled 后停留展示的时长（毫秒），让用户看到收尾状态再关闭。 */
const DISMISS_DELAY_MS = 500

let nextId = 1

const state = reactive({
  active: null as ProgressTask | null,
  queue: [] as ProgressTask[],
})

/** 把任务从展示位移除，并轮到队列中的下一个（若有）。 */
function dismiss(task: ProgressTask) {
  if (state.active !== task) return
  const next = state.queue.shift()
  if (next) {
    next.status = 'active'
    state.active = next
  } else {
    state.active = null
  }
}

export function useProgressStore() {
  /** 当前展示的任务（null 表示无任务）。 */
  function activeTask(): ProgressTask | null {
    return state.active
  }

  /**
   * 启动一个进度任务并返回句柄。
   * 已有活跃任务时进入排队（FIFO），活跃任务结束后自动开始。
   */
  function start(options: ProgressTaskOptions = {}): ProgressTaskHandle {
    // 必须用 reactive() 创建任务：
    // 若用普通对象再赋给 state.active，Vue 会把它包成代理，而句柄闭包持有的是
    // 原始对象——update/done 改原始对象不触发组件更新，且 state.active !== task
    // 的同一性比较失效，任务永远不会被移出展示位。reactive 创建后闭包即持有代理。
    const task = reactive<ProgressTask>({
      ...options,
      id: nextId++,
      progress: options.progress ?? null,
      modal: options.modal ?? false,
      cancellable: options.cancellable ?? false,
      status: state.active ? 'queued' : 'active',
    })
    if (state.active) {
      state.queue.push(task)
    } else {
      state.active = task
    }

    return {
      id: task.id,
      update(progress, message, detail) {
        // 排队中允许先设初值；终态后忽略
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return
        task.progress = progress
        if (message !== undefined) task.message = message
        if (detail !== undefined) task.detail = detail
      },
      done() {
        if (state.active !== task || task.status !== 'active') return
        task.status = 'done'
        setTimeout(() => dismiss(task), DISMISS_DELAY_MS)
      },
      fail(message) {
        if (state.active !== task || task.status !== 'active') return
        task.status = 'failed'
        if (message !== undefined) task.message = message
      },
      cancel() {
        if (state.active !== task || task.status !== 'active') return
        if (!task.cancellable || !task.onCancel) return
        void task.onCancel()
        task.status = 'cancelled'
        setTimeout(() => dismiss(task), DISMISS_DELAY_MS)
      },
    }
  }

  /**
   * 供 GlobalProgress.vue 调用：
   * - 失败任务 → 点击"关闭"后移出展示
   * - 活跃的可取消任务 → 点击"取消"：触发 onCancel 后关闭
   */
  function close(task: ProgressTask) {
    if (state.active !== task) return
    if (task.status === 'failed') {
      dismiss(task)
    } else if (task.status === 'active' && task.cancellable && task.onCancel) {
      void task.onCancel()
      task.status = 'cancelled'
      setTimeout(() => dismiss(task), DISMISS_DELAY_MS)
    }
  }

  return { activeTask, start, close }
}
