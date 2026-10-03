import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

/**
 * 刻意宽松：lint 只抓「真错误」，不查风格（2026-09 起）。
 *
 * 1. **不接 eslint-plugin-prettier**：格式不参与 lint。历史上全仓库 4000+ 报错全部
 *    来自它（且旧配置里那句 `'prettier/prettier': 'warn'` 是死代码——recommended
 *    放在数组最后，error 把 warn 覆盖了回去）。想统一格式时手动跑 `pnpm format`。
 * 2. **Vue 用 `flat/essential` 而非 `flat/recommended`**：前者只含防错规则（废弃
 *    生命周期、废弃事件 API 等），后者还带一大堆格式/顺序类规则。
 * 3. `no-explicit-any` / `no-unused-vars` 关掉：写原型、调试期的噪音，不是错误。
 * 4. `doc/`（资料目录，不参与构建）与 `src/renderer/legacy/`（死代码）不进 lint 范围。
 *
 * 想收紧时按条回滚即可；`eslint-plugin-prettier` / `eslint-config-prettier` 两个
 * 依赖仍留在 package.json 里，随时可以接回来。
 */
export default [
  {
    name: 'app/files-to-lint',
    files: ['**/*.{ts,mts,tsx,vue}'],
  },
  {
    name: 'app/files-to-ignore',
    ignores: [
      '**/dist/**',
      '**/dist-electron/**',
      '**/release/**',
      '**/node_modules/**',
      '**/logs/**',
      '**/coverage/**',
      'doc/**',
      'src/renderer/legacy/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    name: 'app/language-options',
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
  },
  {
    name: 'app/vue-rules',
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    name: 'app/custom-rules',
    // 代码里遗留的 `eslint-disable` 注释不再报"多余"——规则关了以后它们确实没用了，
    // 但删掉只为了消警告（还会留下空白行）不值得，留着以后收紧规则时照样生效
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'vue/multi-word-component-names': 'off',
      'no-console': 'off',
    },
  },
]
