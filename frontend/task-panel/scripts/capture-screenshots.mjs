/**
 * 用本机 Chrome 生成验收截图（F17 视口与无横向溢出检查）。
 * 可选工具：需要先启动 `npm run preview`，并保证本机有 Chrome。
 *   npm run screenshots
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.PANEL_URL ?? 'http://127.0.0.1:4175'
const OUT_DIR = path.resolve('docs/screenshots')

const SHOTS = [
  { name: '01-m01-desktop', width: 1440, height: 900, url: '/?scene=M01&frame=2' },
  { name: '02-m03-waiting-input', width: 1280, height: 720, url: '/?scene=M03' },
  { name: '03-m02-report-first', width: 1280, height: 720, url: '/?scene=M02&frame=1' },
  { name: '04-m10-disconnected', width: 1280, height: 720, url: '/?scene=M10&frame=1' },
  { name: '05-m14-narrow', width: 390, height: 844, url: '/?scene=M14&frame=2' },
]

await mkdir(OUT_DIR, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox', '--in-process-gpu'],
})

const results = []
for (const shot of SHOTS) {
  const page = await browser.newPage()
  await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: 1 })
  await page.goto(`${BASE}${shot.url}`, { waitUntil: 'networkidle0' })
  await new Promise((resolve) => setTimeout(resolve, 700))
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
    hasMockBadge: Array.from(document.querySelectorAll('.mock-badge')).some((node) =>
      node.textContent?.includes('模拟数据'),
    ),
  }))
  await page.screenshot({ path: path.join(OUT_DIR, `${shot.name}.png`) })
  results.push({ name: shot.name, ...metrics })
  await page.close()
}

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 720 },
]

const viewportAudit = []
for (const viewport of VIEWPORTS) {
  const page = await browser.newPage()
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
  await page.goto(`${BASE}/?scene=M14&frame=2`, { waitUntil: 'networkidle0' })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
    columns: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns,
  }))
  viewportAudit.push({ ...viewport, ...metrics, overflow: metrics.scrollWidth > metrics.innerWidth })
  await page.close()
}

await browser.close()
console.log(JSON.stringify({ screenshots: results, viewportAudit }, null, 2))
if (results.some((item) => item.scrollWidth > item.innerWidth)) {
  console.error('存在横向溢出，请检查响应式布局')
  process.exitCode = 1
}
if (results.some((item) => !item.hasMockBadge)) {
  console.error('截图缺少"模拟数据"标记')
  process.exitCode = 1
}
