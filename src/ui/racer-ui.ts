import type { Quality } from '../engine/save'
import { CARS, LEVELS, type CarId, type RaceResult, type RaceViewState, type RacerGame } from '../game/racer'

type RacerSave = {
  unlocked: number
  best: Record<string, number>
  car: CarId
  quality: Quality
  muted: boolean
  volume: number
  tutorialDone: boolean
}

type UiHooks = {
  start(levelId: number, carId: CarId): void
  restart(): void
  resume(): void
  pause(): void
  quit(): void
  quality(value: Quality): void
  mute(value: boolean): void
  car(value: CarId): void
}

const STORAGE_KEY = 'neon-overdrive.save.v1'
const readSave = (): RacerSave => {
  const fallback: RacerSave = { unlocked: 1, best: {}, car: 'specter', quality: 'high', muted: false, volume: 0.75, tutorialDone: false }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<RacerSave>
    return {
      unlocked: Math.max(1, Math.min(5, Number(parsed.unlocked) || 1)),
      best: parsed.best && typeof parsed.best === 'object' ? parsed.best : {},
      car: CARS.some(car => car.id === parsed.car) ? parsed.car as CarId : fallback.car,
      quality: parsed.quality === 'low' || parsed.quality === 'medium' || parsed.quality === 'high' ? parsed.quality : fallback.quality,
      muted: parsed.muted === true,
      volume: typeof parsed.volume === 'number' ? Math.max(0, Math.min(1, parsed.volume)) : fallback.volume,
      tutorialDone: parsed.tutorialDone === true,
    }
  } catch { return fallback }
}

export class RacerUI {
  readonly save = readSave()
  private readonly root: HTMLElement
  private readonly hooks: UiHooks
  private game?: RacerGame
  private active = 'boot'
  private lastMode = ''
  private lastMessage = ''
  private toastTimer = 0

  constructor(root: HTMLElement, hooks: UiHooks) {
    this.root = root
    this.hooks = hooks
    this.root.innerHTML = this.template()
    this.root.addEventListener('click', event => this.handleClick(event))
    this.root.addEventListener('input', event => this.handleInput(event))
    window.addEventListener('keydown', event => {
      if (event.code === 'Enter' && this.active === 'title') this.hooks.start(this.save.unlocked, this.save.car)
      if (event.code === 'Escape' && ['levels', 'garage', 'settings', 'controls', 'credits'].includes(this.active)) this.show('title')
    })
    this.show('boot')
    window.setTimeout(() => this.show('title'), 420)
  }

  attach(game: RacerGame): void {
    this.game = game
    this.refreshLevels()
    this.refreshGarage()
    this.refreshSettings()
  }

  update(state: RaceViewState): void {
    if (state.mode !== this.lastMode) {
      this.lastMode = state.mode
      if (state.mode === 'menu' && this.active === 'hud') this.show('title')
      if (state.mode === 'countdown' || state.mode === 'racing') this.show('hud')
      if (state.mode === 'paused') this.show('pause')
    }
    this.setText('hud-level', `${String(state.levelId).padStart(2, '0')} // ${state.levelName}`)
    this.setText('hud-objective', state.objective)
    this.setText('hud-speed', String(state.speedKmh).padStart(3, '0'))
    this.setText('hud-gear', state.gear)
    this.setText('hud-rpm', `${state.rpm}%`)
    this.setText('hud-position', `${state.position}<small> / ${state.racers}</small>`, true)
    this.setText('hud-time', this.formatTime(state.timer))
    this.setText('hud-limit', `LIMIT ${this.formatTime(state.timeLimit)}`)
    this.setText('hud-checkpoint', `${state.checkpoint} / ${state.checkpointsTotal}`)
    this.setText('hud-drift', state.driftScore.toLocaleString())
    this.setText('hud-car', state.carName)
    this.setText('countdown', state.countdown)
    const progress = this.root.querySelector<HTMLElement>('.hud-progress')
    if (progress) progress.style.width = `${Math.round(state.progress * 100)}%`
    const nitro = this.root.querySelector<HTMLElement>('.nitro-fill')
    if (nitro) nitro.style.width = `${Math.round((state.nitro / (this.game?.selectedCar.nitro ?? 100)) * 100)}%`
    const rpm = this.root.querySelector<HTMLElement>('.rpm-fill')
    if (rpm) rpm.style.width = `${state.rpm}%`
    this.root.querySelector('.hud-drift-box')?.classList.toggle('is-hot', state.driftScore > 0)
    if (state.message && state.message !== this.lastMessage) {
      this.lastMessage = state.message
      this.toast(state.message, 'info')
    }
  }

  notify(message: string, kind: 'info' | 'success' | 'warning' = 'info'): void { this.toast(message, kind) }

  finish(result: RaceResult): void {
    const key = String(result.levelId)
    const previous = this.save.best[key]
    const newBest = result.won && (!previous || result.time < previous)
    if (newBest) this.save.best[key] = result.time
    if (result.won) this.save.unlocked = Math.max(this.save.unlocked, Math.min(5, result.levelId + 1))
    this.save.tutorialDone = true
    this.persist()
    this.setText('result-status', result.won ? 'EVENT COMPLETE' : 'RUN TERMINATED')
    this.setText('result-title', result.won ? 'NIGHT CLAIMED' : 'SIGNAL LOST')
    this.setText('result-position', `P${result.position}`)
    this.setText('result-time', this.formatTime(result.time))
    this.setText('result-drift', result.driftScore.toLocaleString())
    this.setText('result-best', this.save.best[key] ? this.formatTime(this.save.best[key]) : '--:--.--')
    this.setText('result-note', newBest ? 'NEW PERSONAL BEST // SECTOR DATA SAVED' : result.won ? 'SECTOR DATA SAVED // NEXT EVENT UNLOCKED' : 'RETRY THE RUN // THE NIGHT IS NOT DONE')
    const next = this.root.querySelector<HTMLButtonElement>('[data-action="next"]')
    if (next) next.disabled = !result.won || result.levelId >= 5
    this.show('results')
  }

  show(screen: string): void {
    this.active = screen
    this.root.dataset.screen = screen
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-screen]')) {
      const active = el.dataset.screen === screen || (screen === 'pause' && el.dataset.screen === 'hud')
      el.classList.toggle('is-active', active)
      el.setAttribute('aria-hidden', String(!active))
    }
    if (screen === 'levels') this.refreshLevels()
    if (screen === 'garage') this.refreshGarage()
    if (screen === 'settings') this.refreshSettings()
  }

  private handleClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
    if (!target) return
    const action = target.dataset.action
    if (target.dataset.quality) {
      this.save.quality = target.dataset.quality as Quality
      this.persist()
      this.hooks.quality(this.save.quality)
      this.refreshSettings()
      this.toast(`QUALITY // ${this.save.quality.toUpperCase()}`, 'success')
      return
    }
    if (action === 'play') this.hooks.start(this.save.unlocked, this.save.car)
    else if (action === 'levels') this.show('levels')
    else if (action === 'garage') this.show('garage')
    else if (action === 'settings') this.show('settings')
    else if (action === 'controls') this.show('controls')
    else if (action === 'credits') this.show('credits')
    else if (action === 'back') this.show('title')
    else if (action === 'resume') { this.hooks.resume(); this.show('hud') }
    else if (action === 'pause') { this.hooks.pause(); this.show('pause') }
    else if (action === 'restart') { this.hooks.restart(); this.show('hud') }
    else if (action === 'quit') { this.hooks.quit(); this.show('title') }
    else if (action === 'retry') { this.hooks.restart(); this.show('hud') }
    else if (action === 'next') {
      const nextLevel = Math.min(5, (this.game?.selectedLevel.id ?? 1) + 1)
      this.hooks.start(nextLevel, this.save.car)
    } else if (action === 'select-level') {
      const level = Number(target.dataset.level)
      if (level <= this.save.unlocked) this.hooks.start(level, this.save.car)
    } else if (action === 'select-car') {
      const car = target.dataset.car as CarId
      if (CARS.some(item => item.id === car)) { this.save.car = car; this.persist(); this.hooks.car(car); this.refreshGarage(); this.toast(`${CARS.find(item => item.id === car)?.name} // SELECTED`, 'success') }
    } else if (action === 'mute') {
      this.save.muted = !this.save.muted
      this.persist()
      this.hooks.mute(this.save.muted)
      this.refreshSettings()
    }
  }

  private handleInput(event: Event): void {
    const target = event.target as HTMLInputElement
    if (target.name !== 'volume') return
    this.save.volume = Number(target.value) / 100
    this.persist()
  }

  private refreshLevels(): void {
    const list = this.root.querySelector('.level-list')
    if (!list) return
    list.innerHTML = LEVELS.map(level => {
      const locked = level.id > this.save.unlocked
      const best = this.save.best[String(level.id)]
      return `<button class="level-card ${locked ? 'is-locked' : ''}" data-action="select-level" data-level="${level.id}" ${locked ? 'disabled' : ''}><span class="level-number">0${level.id}</span><span><b>${level.name}</b><small>${level.subtitle}</small></span><em>${locked ? 'LOCKED' : best ? this.formatTime(best) : level.difficulty}</em></button>`
    }).join('')
  }

  private refreshGarage(): void {
    const list = this.root.querySelector('.garage-list')
    if (!list) return
    list.innerHTML = CARS.map(car => `<button class="car-card ${car.id === this.save.car ? 'is-selected' : ''}" data-action="select-car" data-car="${car.id}"><span class="car-swatch" style="--car:${this.hex(car.color)};--accent:${this.hex(car.accent)}"></span><strong>${car.name}</strong><small>${car.tagline}</small><span class="stat">TOP SPEED <i style="width:${Math.round(car.maxSpeed / 60 * 100)}%"></i></span><span class="stat">ACCELERATION <i style="width:${Math.round(car.acceleration / 26 * 100)}%"></i></span><span class="stat">HANDLING <i style="width:${Math.round(car.handling / 1.25 * 100)}%"></i></span></button>`).join('')
  }

  private refreshSettings(): void {
    const volume = this.root.querySelector<HTMLInputElement>('[name="volume"]')
    if (volume) volume.value = String(Math.round(this.save.volume * 100))
    this.setText('volume-value', `${Math.round(this.save.volume * 100)}%`)
    const mute = this.root.querySelector<HTMLElement>('[data-action="mute"]')
    if (mute) mute.textContent = this.save.muted ? 'AUDIO OFF' : 'AUDIO ON'
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-quality]')) button.classList.toggle('is-selected', button.dataset.quality === this.save.quality)
  }

  private template(): string {
    return `<section class="screen boot-screen is-active" data-screen="boot"><div class="boot-mark">NO</div><div class="boot-title">NEON OVERDRIVE</div><div class="boot-bar"><i></i></div><div class="boot-caption">INITIALIZING NIGHT GRID</div></section>
<section class="screen title-screen" data-screen="title"><div class="title-glow"></div><div class="title-grid"></div><div class="title-copy"><div class="eyebrow">GAMEATHON 8.0 // SINGLE PLAYER ARCADE RACING</div><h1>THE RACER<span>OWN THE NIGHT</span></h1><p>NEON OVERDRIVE</p><div class="title-rule"></div><div class="title-actions"><button class="cta" data-action="play">START RACE <b>↗</b></button><button data-action="levels">LEVEL SELECT</button><button data-action="garage">GARAGE</button><button data-action="settings">SETTINGS</button><button data-action="controls">CONTROLS</button><button data-action="credits">CREDITS</button></div></div><div class="title-footer">W / A / S / D DRIVE <span>SPACE DRIFT</span><span>SHIFT NITRO</span><span>ESC PAUSE</span></div><div class="title-build">BUILD 01 // 60 FPS TARGET</div></section>
<section class="screen panel-screen" data-screen="levels"><div class="panel"><div class="panel-head"><span class="eyebrow">EVENT CALENDAR</span><h2>LEVEL SELECT</h2><p>Clear events to unlock the route.</p></div><div class="level-list"></div><button class="text-btn" data-action="back">← BACK TO MENU</button></div></section>
<section class="screen panel-screen" data-screen="garage"><div class="panel"><div class="panel-head"><span class="eyebrow">VEHICLE SYSTEMS</span><h2>GARAGE</h2><p>Pick your weapon for the night.</p></div><div class="garage-list"></div><button class="text-btn" data-action="back">← BACK TO MENU</button></div></section>
<section class="screen panel-screen" data-screen="settings"><div class="panel narrow"><div class="panel-head"><span class="eyebrow">SYSTEM CONFIG</span><h2>SETTINGS</h2><p>Performance and audio.</p></div><div class="setting-row"><span>MASTER VOLUME</span><input name="volume" type="range" min="0" max="100" value="75"><b id="volume-value">75%</b></div><div class="setting-row"><span>AUDIO BUS</span><button class="setting-toggle" data-action="mute">AUDIO ON</button></div><div class="setting-row quality-row"><span>GRAPHICS QUALITY</span><div><button data-quality="low">LOW</button><button data-quality="medium">MED</button><button data-quality="high">HIGH</button></div></div><button class="text-btn" data-action="back">← BACK TO MENU</button></div></section>
<section class="screen panel-screen" data-screen="controls"><div class="panel narrow"><div class="panel-head"><span class="eyebrow">DRIVER BRIEFING</span><h2>CONTROLS</h2><p>Every input is live in the cockpit.</p></div><div class="control-grid"><span><kbd>W</kbd><kbd>↑</kbd> ACCELERATE</span><span><kbd>S</kbd><kbd>↓</kbd> BRAKE / REVERSE</span><span><kbd>A</kbd><kbd>D</kbd> STEER</span><span><kbd>SPACE</kbd> HANDBRAKE / DRIFT</span><span><kbd>SHIFT</kbd> NITRO BOOST</span><span><kbd>E</kbd> CAMERA VIEW</span><span><kbd>C</kbd> LOOK BEHIND</span><span><kbd>R</kbd> SAFE RESET</span><span><kbd>ESC</kbd> PAUSE / RESUME</span><span><kbd>ENTER</kbd> START / RESTART</span></div><button class="text-btn" data-action="back">← BACK TO MENU</button></div></section>
<section class="screen panel-screen" data-screen="credits"><div class="panel narrow credits"><div class="panel-head"><span class="eyebrow">SIGNAL LOG // 2026</span><h2>CREDITS</h2></div><p><b>THE RACER: OWN THE NIGHT</b><br>NEON OVERDRIVE is a browser-native Three.js arcade racer built for Gameathon 8.0.</p><p>Drive the line. Chase the glow. Own the night.</p><p class="muted">Built with Three.js, Vite, Web Audio, and the Manus game runtime.</p><button class="text-btn" data-action="back">← BACK TO MENU</button></div></section>
<section class="screen hud-screen" data-screen="hud"><div class="hud-top"><div><span class="eyebrow">EVENT</span><b id="hud-level">01 // MOUNTAIN RUSH</b><small id="hud-objective">Clear 5 checkpoints and beat the clock.</small></div><div class="hud-timer"><small id="hud-limit">LIMIT 01:32.00</small><b id="hud-time">00:00.00</b></div><button class="pause-icon" data-action="pause">Ⅱ</button></div><div class="hud-left"><div class="metric-card"><span>SPEED</span><strong id="hud-speed">000</strong><small>KM/H</small></div><div class="gear-card"><span>GEAR</span><strong id="hud-gear">N</strong><small>RPM <b id="hud-rpm">0%</b></small><i class="rpm-bar"><em class="rpm-fill"></em></i></div></div><div class="hud-right"><div class="position-card"><span>POSITION</span><strong id="hud-position">1<small> / 6</small></strong></div><div class="checkpoint-card"><span>CHECKPOINT</span><strong id="hud-checkpoint">0 / 5</strong><i class="checkpoint-bar"><em class="hud-progress"></em></i></div><div class="hud-drift-box"><span>DRIFT BANK</span><strong id="hud-drift">0</strong></div></div><div class="hud-bottom"><div class="nitro-card"><span>NITRO <b id="hud-car">SPECTER GT</b></span><i class="nitro-bar"><em class="nitro-fill"></em></i><small>HOLD <kbd>SHIFT</kbd></small></div><div class="hud-route"><span>ROUTE TELEMETRY</span><i><em></em></i></div><div class="hud-controls"><kbd>WASD</kbd> DRIVE <kbd>SPACE</kbd> DRIFT <kbd>R</kbd> RESET</div></div><div class="countdown" id="countdown"></div><div class="toast-stack"></div></section>
<section class="screen pause-screen" data-screen="pause"><div class="pause-panel"><span class="eyebrow">RACE PAUSED // SIGNAL HELD</span><h2>HOLD THE LINE</h2><button class="cta" data-action="resume">RESUME</button><button data-action="restart">RESTART RACE</button><button data-action="settings">SETTINGS</button><button data-action="quit">RETURN TO MENU</button></div></section>
<section class="screen results-screen" data-screen="results"><div class="results-panel"><span class="eyebrow" id="result-status">EVENT COMPLETE</span><h2 id="result-title">NIGHT CLAIMED</h2><div class="result-main"><strong id="result-position">P1</strong><span>FINAL POSITION</span></div><div class="result-grid"><div><small>TIME</small><b id="result-time">00:00.00</b></div><div><small>BEST</small><b id="result-best">--:--.--</b></div><div><small>DRIFT SCORE</small><b id="result-drift">0</b></div></div><p id="result-note">SECTOR DATA SAVED</p><div class="result-actions"><button class="cta" data-action="next">NEXT EVENT</button><button data-action="retry">RETRY</button><button data-action="quit">MENU</button></div></div></section>`
  }

  private toast(message: string, kind: string): void {
    const stack = this.root.querySelector('.toast-stack')
    if (!stack) return
    const item = document.createElement('div')
    item.className = `toast toast-${kind}`
    item.textContent = message
    stack.append(item)
    window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => item.remove(), 2600)
  }

  private setText(selector: string, text: string, html = false): void {
    const el = this.root.querySelector<HTMLElement>(`#${selector}`)
    if (el) html ? el.innerHTML = text : el.textContent = text
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`
  }
  private hex(value: number): string { return `#${value.toString(16).padStart(6, '0')}` }
  private persist(): void { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.save)) } catch { /* game remains playable */ } }
}

export { STORAGE_KEY }
