import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

/**
 * 图标生成脚本
 *
 * 从 resources/icon.png 自动生成 Windows 打包所需的 icon.ico
 * 以及 16/24/32/48/64/128/256 尺寸的 PNG 图标。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const SOURCE_PATH = path.join(ROOT, 'resources', 'icon.png')
const OUTPUT_DIR = path.join(ROOT, 'resources')

/** 需要生成的图标尺寸。 */
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * 校验源图标是否存在且可读。
 */
function validateSource(): void {
  if (!fs.existsSync(SOURCE_PATH)) {
    console.error(`[generate-icons] 错误：源图标不存在：${SOURCE_PATH}`)
    console.error('[generate-icons] 请将 PNG 图标放到 resources/icon.png，建议尺寸 1024x1024。')
    process.exit(1)
  }

  const stat = fs.statSync(SOURCE_PATH)
  if (!stat.isFile()) {
    console.error(`[generate-icons] 错误：${SOURCE_PATH} 不是文件。`)
    process.exit(1)
  }
}

/**
 * 生成所有尺寸的 PNG 图标。
 *
 * 如果源图不是正方形，会先居中裁剪，避免图标变形。
 */
async function generatePngIcons(): Promise<string[]> {
  const metadata = await sharp(SOURCE_PATH).metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0

  if (width === 0 || height === 0) {
    throw new Error('无法读取源图标尺寸')
  }

  const cropSize = Math.min(width, height)
  const left = Math.floor((width - cropSize) / 2)
  const top = Math.floor((height - cropSize) / 2)

  console.log(`[generate-icons] 源图标尺寸 ${width}x${height}，将居中裁剪为 ${cropSize}x${cropSize}`)

  const baseImage = sharp(SOURCE_PATH).extract({
    left,
    top,
    width: cropSize,
    height: cropSize,
  })

  const generatedPaths: string[] = []

  for (const size of ICON_SIZES) {
    const outputPath = path.join(OUTPUT_DIR, `icon-${size}.png`)
    await baseImage.clone().resize(size, size, { fit: 'cover' }).png().toFile(outputPath)
    generatedPaths.push(outputPath)
    console.log(`[generate-icons] 已生成 ${outputPath}`)
  }

  return generatedPaths
}

/**
 * 根据多尺寸 PNG 生成 ICO 文件。
 */
async function generateIco(pngPaths: string[]): Promise<void> {
  const icoPath = path.join(OUTPUT_DIR, 'icon.ico')
  const icoBuffer = await pngToIco(pngPaths)
  fs.writeFileSync(icoPath, icoBuffer)
  console.log(`[generate-icons] 已生成 ${icoPath}`)
}

/**
 * 脚本主入口。
 */
async function main(): Promise<void> {
  validateSource()
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const pngPaths = await generatePngIcons()
  await generateIco(pngPaths)

  console.log('[generate-icons] 图标生成完成。')
}

main().catch((err) => {
  console.error('[generate-icons] 生成图标失败：', err)
  process.exit(1)
})
