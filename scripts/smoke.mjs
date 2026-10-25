import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
let browser
const guard = setTimeout(() => fail('timed out'), 120_000)
function cleanup() { clearTimeout(guard); try { server.kill('SIGTERM') } catch {} }
async function fail(message) { console.error(`smoke: FAIL — ${message}`); await browser?.close().catch(() => {}); cleanup(); process.exit(1) }
async function waitForServer() { for (let i = 0; i < 60; i += 1) { try { if ((await fetch(url)).ok) return } catch {} await new Promise(resolve => setTimeout(resolve, 250)) } throw new Error('preview server did not start') }
const state = page => page.evaluate(() => window.__game.game.getSnapshot())
const step = (page, frames) => page.evaluate(framesToRun => { const { game, ui } = window.__game; for (let i = 0; i < framesToRun; i += 1) game.update(1 / 60); ui.update(game.getSnapshot()) }, frames)

try {
  await waitForServer()
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--ignore-gpu-blocklist', '--no-sandbox'] })
  const errors = []
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  page.on('console', message => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', error => errors.push(String(error)))
  page.on('response', response => response.status() >= 400 && errors.push(`HTTP ${response.status()} ${response.url()}`))
  await page.goto(url)
  await page.waitForSelector('[data-screen="title"].is-active', { timeout: 30_000 })
  await page.screenshot({ path: `${out}/01-title.png` })
  await page.click('[data-action="play"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await step(page, 210)
  const before = await state(page)
  await page.evaluate(() => window.__game.game.input.keys.add('KeyW'))
  await step(page, 60)
  await page.evaluate(() => window.__game.game.input.keys.delete('KeyW'))
  const after = await state(page)
  if (after.mode !== 'racing') throw new Error(`expected racing, got ${after.mode}`)
  if (after.speedKmh <= 0 || after.progress <= before.progress) throw new Error(`car did not move: ${JSON.stringify({ before, after })}`)
  await page.evaluate(() => { const g = window.__game.game; g.input.keys.add('KeyW'); g.input.keys.add('ShiftLeft') })
  await step(page, 36)
  const boosted = await state(page)
  await page.evaluate(() => { const g = window.__game.game; g.input.keys.delete('KeyW'); g.input.keys.delete('ShiftLeft') })
  if (boosted.nitro >= after.nitro) throw new Error('nitro did not consume')
  await page.screenshot({ path: `${out}/02-race.png` })
  await page.evaluate(() => { const { game, ui } = window.__game; game.setPaused(true); ui.update(game.getSnapshot()) })
  await page.waitForSelector('[data-screen="pause"].is-active')
  if ((await state(page)).mode !== 'paused') throw new Error('pause did not change game mode')
  await page.screenshot({ path: `${out}/03-pause.png` })
  await page.click('[data-action="resume"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  await page.evaluate(() => window.__game.game['finish'](true))
  await page.waitForSelector('[data-screen="results"].is-active')
  await page.screenshot({ path: `${out}/04-results.png` })
  await page.locator('.results-screen [data-action="quit"]').click()
  await page.waitForSelector('[data-screen="title"].is-active')
  await page.click('[data-action="levels"]')
  await page.waitForSelector('[data-screen="levels"].is-active')
  const unlocked = await page.locator('[data-action="select-level"]:not([disabled])').count()
  if (unlocked < 2) throw new Error(`expected next level to unlock, got ${unlocked}`)
  await page.screenshot({ path: `${out}/05-levels.png` })
  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close(); cleanup(); console.log(`smoke: OK — racer movement, nitro, pause, results, and progression verified in ${out}/`)
} catch (error) { await fail(error?.message ?? String(error)) }
