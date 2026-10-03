import { reactive } from 'vue'

/**
 * 控制台日志状态（模块级单例）。
 *
 * 仿 CloudCompare 的 Console：每条日志一行，
 * 格式 [HH:MM:SS] [来源] 消息，如 [12:49:24] [LAS] Cloud has been re-centered! ...
 */

/** 控制台日志条目。 */
export interface ConsoleEntry {
  id: number
  /** HH:MM:SS 格式时间。 */
  time: string
  /** 来源标签，如 LAS / PLY / App。 */
  source: string
  message: string
}

let nextId = 1

const state = reactive({
  entries: [] as ConsoleEntry[],
})

function fmtTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function useConsoleStore() {
  /** 追加一条日志。 */
  function log(source: string, message: string) {
    state.entries.push({
      id: nextId++,
      time: fmtTime(new Date()),
      source,
      message,
    })
  }

  /** 清空控制台。 */
  function clear() {
    state.entries = []
  }

  return { entries: state.entries, log, clear }
}
