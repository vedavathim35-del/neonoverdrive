import './styles/main.css'
import { Renderer, suggestQuality } from './engine/renderer'
import { createRacerGame, type CarId, type RaceResult, type RacerGame } from './game/racer'
import { RacerUI } from './ui/racer-ui'

class SoundBank {
  private context?: AudioContext
  private muted = false
  private volume = 0.75

  setMuted(value: boolean): void { this.muted = value }
  setVolume(value: number): void { this.volume = value }
  unlock(): void {
    if (!this.context) this.context = new AudioContext()
    if (this.context.state === 'suspended') void this.context.resume()
  }
  ping(kind: 'info' | 'success' | 'warning' = 'info'): void {
    if (this.muted) return
    this.unlock()
    const context = this.context
    if (!context) return
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const frequency = kind === 'success' ? 880 : kind === 'warning' ? 150 : 420
    oscillator.type = kind === 'success' ? 'triangle' : 'sawtooth'
    oscillator.frequency.setValueAtTime(frequency, context.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.55, context.currentTime + 0.14)
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.045 * this.volume, context.currentTime + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.2)
  }
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')
  const root = document.getElementById('ui')
  if (!canvas || !root) throw new Error('Neon Overdrive shell is incomplete')
  const initialSave = (() => {
    try {
      const raw = localStorage.getItem('neon-overdrive.save.v1')
      return raw ? JSON.parse(raw) as { quality?: string; muted?: boolean; volume?: number; car?: CarId } : {}
    } catch { return {} }
  })()
  const quality = initialSave.quality === 'low' || initialSave.quality === 'medium' || initialSave.quality === 'high' ? initialSave.quality : suggestQuality()
  const sound = new SoundBank()
  sound.setMuted(initialSave.muted === true)
  sound.setVolume(typeof initialSave.volume === 'number' ? initialSave.volume : 0.75)
  let game: RacerGame | undefined
  let renderer: Renderer | undefined
  const ui = new RacerUI(root, {
    start: (levelId, carId) => { sound.unlock(); game?.start(levelId, carId) },
    restart: () => { sound.unlock(); game?.restart() },
    resume: () => game?.setPaused(false),
    pause: () => game?.setPaused(true),
    quit: () => { game?.setPaused(false); game?.toMenu() },
    quality: value => renderer?.applyQuality(value),
    mute: value => sound.setMuted(value),
    car: (_value: CarId) => sound.ping('info'),
  })
  renderer = new Renderer(canvas, quality)
  game = createRacerGame(renderer, {
    notify: (message, kind) => { ui.notify(message, kind); sound.ping(kind) },
    finish: (result: RaceResult) => { ui.finish(result); sound.ping(result.won ? 'success' : 'warning') },
    saveTutorial: () => { ui.save.tutorialDone = true },
  })
  ui.attach(game)
  sound.setMuted(ui.save.muted)
  sound.setVolume(ui.save.volume)
  ;(window as unknown as { __game: unknown }).__game = { game, ui, input: game.input, save: ui.save }

  let previous = performance.now()
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - previous) / 1000)
    previous = now
    game?.update(dt)
    if (game) {
      game.render(dt)
      ui.update(game.getSnapshot())
    }
    requestAnimationFrame(frame)
  }
  await document.fonts.ready
  requestAnimationFrame(frame)
}

boot().catch(error => {
  console.error(error)
  const root = document.getElementById('ui')
  if (root) root.innerHTML = `<div class="fatal">SYSTEM BOOT FAILED<br><small>${String((error as Error)?.message ?? error).replace(/[<>&]/g, '')}</small></div>`
})
