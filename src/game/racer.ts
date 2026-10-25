import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Renderer } from '../engine/renderer'

export type RaceMode = 'menu' | 'countdown' | 'racing' | 'paused' | 'finished'
export type CarId = 'specter' | 'vortex' | 'apex'
export type RaceResult = {
  levelId: number
  won: boolean
  position: number
  time: number
  bestTime: number | null
  driftScore: number
}

export type RaceViewState = {
  mode: RaceMode
  levelId: number
  levelName: string
  objective: string
  difficulty: string
  speedKmh: number
  gear: string
  rpm: number
  nitro: number
  position: number
  racers: number
  timer: number
  timeLimit: number
  checkpoint: number
  checkpointsTotal: number
  progress: number
  driftScore: number
  countdown: string
  message: string
  camera: 'chase' | 'hood' | 'rear'
  carName: string
}

export type RacerHooks = {
  notify(message: string, kind?: 'info' | 'success' | 'warning'): void
  finish(result: RaceResult): void
  saveTutorial(): void
}

type Level = {
  id: number
  name: string
  subtitle: string
  objective: string
  difficulty: string
  length: number
  timeLimit: number
  roadWidth: number
  theme: 'mountain' | 'highway' | 'city' | 'drift' | 'overdrive'
  aiSpeed: number
  traffic: number
}

type CarSpec = {
  id: CarId
  name: string
  tagline: string
  color: number
  accent: number
  maxSpeed: number
  acceleration: number
  handling: number
  nitro: number
}

type Rival = { root: THREE.Group; progress: number; lane: number; speed: number; phase: number }
type Traffic = { root: THREE.Group; progress: number; lane: number; speed: number; phase: number }

type InputState = {
  keys: Set<string>
  justPressed: Set<string>
}

export const LEVELS: Level[] = [
  { id: 1, name: 'Mountain Rush', subtitle: 'PINE RIDGE // FIRST LIGHT', objective: 'Clear 5 checkpoints and beat the clock.', difficulty: 'ROOKIE', length: 940, timeLimit: 92, roadWidth: 12, theme: 'mountain', aiSpeed: 29, traffic: 3 },
  { id: 2, name: 'Highway Pursuit', subtitle: 'I-09 // NO BRAKE ZONE', objective: 'Overtake the pack on the open highway.', difficulty: 'PRO', length: 1120, timeLimit: 86, roadWidth: 15, theme: 'highway', aiSpeed: 34, traffic: 7 },
  { id: 3, name: 'Neon City Run', subtitle: 'SECTOR 7 // AFTER DARK', objective: 'Thread the city grid without losing pace.', difficulty: 'EXPERT', length: 980, timeLimit: 88, roadWidth: 11, theme: 'city', aiSpeed: 32, traffic: 6 },
  { id: 4, name: 'Midnight Drift', subtitle: 'DOCKSIDE // SIDEWAYS ONLY', objective: 'Stack drift score through technical bends.', difficulty: 'ELITE', length: 900, timeLimit: 96, roadWidth: 10, theme: 'drift', aiSpeed: 28, traffic: 2 },
  { id: 5, name: 'Final Overdrive', subtitle: 'THE LOOP // OWN THE NIGHT', objective: 'Survive every sector and win the finale.', difficulty: 'BOSS', length: 1320, timeLimit: 110, roadWidth: 13, theme: 'overdrive', aiSpeed: 37, traffic: 8 },
]

export const CARS: CarSpec[] = [
  { id: 'specter', name: 'SPECTER GT', tagline: 'Balanced night hunter', color: 0x1b2638, accent: 0x00efff, maxSpeed: 55, acceleration: 21, handling: 1.0, nitro: 100 },
  { id: 'vortex', name: 'VORTEX R', tagline: 'Raw acceleration // loose rear', color: 0x461c49, accent: 0xff2bb5, maxSpeed: 58, acceleration: 24, handling: 0.84, nitro: 86 },
  { id: 'apex', name: 'APEX RS', tagline: 'Precision // razor response', color: 0x172e2b, accent: 0xb4ff4d, maxSpeed: 52, acceleration: 20, handling: 1.2, nitro: 116 },
]

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const damp = (current: number, target: number, smoothing: number, dt: number) => THREE.MathUtils.lerp(current, target, 1 - Math.exp(-smoothing * dt))
const GENERATED_CAR_URL = '/manus-storage/game/sha256/ab08fad97a7e55399de62c87253cc9ee734a9f6527df4d1b1a1a8c58024f458b.glb'

function mat(color: number, emissive = 0, intensity = 1, roughness = 0.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness, emissive, emissiveIntensity: intensity })
}
function neon(color: number, intensity = 2.4): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: intensity < 1, opacity: Math.min(1, 0.48 + intensity * 0.18) })
}
function box(size: THREE.Vector3, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

export class RacerGame {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2500)
  readonly input: InputState = { keys: new Set(), justPressed: new Set() }
  readonly state: RaceViewState = {
    mode: 'menu', levelId: 1, levelName: LEVELS[0].name, objective: LEVELS[0].objective, difficulty: LEVELS[0].difficulty,
    speedKmh: 0, gear: 'N', rpm: 0, nitro: 100, position: 1, racers: 6, timer: 0, timeLimit: LEVELS[0].timeLimit,
    checkpoint: 0, checkpointsTotal: 5, progress: 0, driftScore: 0, countdown: '', message: '', camera: 'chase', carName: CARS[0].name,
  }

  private readonly world = new THREE.Group()
  private readonly road = new THREE.Group()
  private readonly actors = new THREE.Group()
  private readonly effects = new THREE.Group()
  private readonly player = new THREE.Group()
  private playerWheels: THREE.Mesh[] = []
  private playerGlow?: THREE.Mesh
  private generatedCar?: THREE.Group
  private currentLevel = LEVELS[0]
  private currentCar = CARS[0]
  private rivals: Rival[] = []
  private traffic: Traffic[] = []
  private checkpoints: number[] = []
  private cameraMode: 'chase' | 'hood' | 'rear' = 'chase'
  private yaw = 0
  private speed = 0
  private nitro = 100
  private driftScore = 0
  private raceTime = 0
  private countdownTime = 0
  private crashCooldown = 0
  private skidClock = 0
  private attractTime = 0
  private lastNotify = ''
  private tutorialShown = false
  private finishedResult?: RaceResult
  private readonly hooks: RacerHooks

  constructor(private readonly renderer: Renderer, hooks: RacerHooks) {
    this.hooks = hooks
    this.scene.fog = new THREE.FogExp2(0x060913, 0.0027)
    this.scene.add(this.world)
    this.world.add(this.road, this.actors, this.effects)
    this.createPlayerCar()
    this.world.add(this.player)
    this.bindInput()
    this.buildAttractScene()
    void this.loadGeneratedCar()
  }

  start(levelId = 1, carId: CarId = this.currentCar.id): void {
    const level = LEVELS.find(item => item.id === levelId) ?? LEVELS[0]
    this.currentLevel = level
    this.currentCar = CARS.find(item => item.id === carId) ?? CARS[0]
    this.createPlayerCar()
    this.state.levelId = level.id
    this.state.levelName = level.name
    this.state.objective = level.objective
    this.state.difficulty = level.difficulty
    this.state.timeLimit = level.timeLimit
    this.state.timer = 0
    this.state.progress = 0
    this.state.checkpoint = 0
    this.state.checkpointsTotal = 5
    this.state.position = 1
    this.state.racers = 6
    this.state.driftScore = 0
    this.state.message = level.id === 1 && !this.tutorialShown ? 'W / A / S / D to drive  •  SPACE to drift  •  SHIFT to boost' : 'GET READY'
    this.state.countdown = '3'
    this.state.mode = 'countdown'
    this.state.camera = 'chase'
    this.state.carName = this.currentCar.name
    this.cameraMode = 'chase'
    this.finishedResult = undefined
    this.speed = 0
    this.nitro = this.currentCar.nitro
    this.driftScore = 0
    this.raceTime = 0
    this.countdownTime = 0
    this.crashCooldown = 0
    this.skidClock = 0
    this.input.justPressed.clear()
    this.clearTrack()
    this.buildTrack(level)
    const start = this.trackPoint(0)
    this.player.position.copy(start)
    this.player.position.y = 0.62
    this.yaw = this.trackHeading(0)
    this.player.rotation.y = this.yaw
    this.camera.position.copy(this.player.position).add(new THREE.Vector3(0, 4.1, 9))
    this.notify(level.id === 1 && !this.tutorialShown ? 'TUTORIAL // FIND YOUR LINE' : `${level.name} // GRID LOCKED`, 'info')
  }

  restart(): void {
    this.start(this.currentLevel.id, this.currentCar.id)
  }

  toMenu(): void {
    this.state.mode = 'menu'
    this.state.countdown = ''
    this.state.message = ''
    this.buildAttractScene()
  }

  setPaused(paused: boolean): void {
    if (paused && (this.state.mode === 'racing' || this.state.mode === 'countdown')) this.state.mode = 'paused'
    else if (!paused && this.state.mode === 'paused') this.state.mode = this.countdownTime < 3.2 ? 'countdown' : 'racing'
  }

  get selectedCar(): CarSpec { return this.currentCar }
  get selectedLevel(): Level { return this.currentLevel }

  update(dt: number): void {
    const delta = clamp(dt, 0, 0.05)
    if (this.state.mode === 'menu') {
      this.attractTime += delta
      this.player.rotation.y = Math.sin(this.attractTime * 0.25) * 0.08
      return
    }
    if (this.state.mode === 'paused' || this.state.mode === 'finished') return
    if (this.state.mode === 'countdown') {
      this.countdownTime += delta
      const left = 3.2 - this.countdownTime
      this.state.countdown = left > 2.15 ? '3' : left > 1.1 ? '2' : left > 0 ? '1' : 'GO'
      if (this.countdownTime >= 3.2) {
        this.state.mode = 'racing'
        this.state.countdown = ''
        this.raceTime = 0
        this.notify('GO // OWN THE NIGHT', 'success')
      }
      this.updateCamera(delta)
      return
    }
    this.raceTime += delta
    this.state.timer = this.raceTime
    this.crashCooldown = Math.max(0, this.crashCooldown - delta)
    this.updatePlayer(delta)
    this.updateRivals(delta)
    this.updateTraffic(delta)
    this.updateRaceState()
    this.updateCamera(delta)
  }

  render(frameSeconds: number): void {
    const boostVisible = this.state.mode === 'racing' && this.input.keys.has('ShiftLeft') && this.nitro > 0 && this.speed > 8
    if (this.playerGlow) {
      this.playerGlow.visible = boostVisible
      this.playerGlow.scale.setScalar(1 + Math.sin(this.attractTime * 32) * 0.12)
    }
    for (const wheel of this.playerWheels) wheel.rotation.x -= this.speed * frameSeconds * 1.4
    this.renderer.render(this.scene, this.camera)
  }

  getSnapshot(): RaceViewState { return { ...this.state, nitro: this.nitro, driftScore: Math.floor(this.driftScore), camera: this.cameraMode } }
  get finished(): RaceResult | undefined { return this.finishedResult }

  private buildAttractScene(): void {
    this.clearTrack()
    this.buildTrack(LEVELS[0])
    this.player.position.set(this.trackPoint(0).x, 0.62, this.trackPoint(0).z)
    this.player.rotation.y = 0.02
    this.camera.position.set(11, 7.5, 14)
    this.camera.lookAt(0, 1, -20)
  }

  private clearTrack(): void {
    for (const child of [...this.road.children]) child.removeFromParent()
    for (const child of [...this.actors.children]) child.removeFromParent()
    for (const child of [...this.effects.children]) child.removeFromParent()
    this.rivals = []
    this.traffic = []
    this.checkpoints = []
  }

  private buildTrack(level: Level): void {
    this.currentLevel = level
    this.scene.background = new THREE.Color(level.theme === 'city' ? 0x05040e : 0x050912)
    this.scene.fog = new THREE.FogExp2(level.theme === 'city' ? 0x07051a : 0x07111b, level.theme === 'highway' ? 0.0018 : 0.0028)
    const ambient = this.scene.getObjectByName('ambient') as THREE.HemisphereLight | undefined
    if (ambient) ambient.color.setHex(level.theme === 'city' ? 0x6050aa : 0x263b65)
    this.createRoadMeshes(level)
    this.createEnvironment(level)
    this.createCheckpoints(level)
    this.createFinishLine(level)
    this.createRivals(level)
    this.createTraffic(level)
  }

  private createRoadMeshes(level: Level): void {
    const asphalt = mat(level.theme === 'drift' ? 0x15121d : 0x101723, 0x02040a, 0.15, 0.88)
    const shoulder = mat(0x242a37, 0x05070c, 0.2, 0.74)
    const edge = neon(level.theme === 'city' ? 0xff2bb5 : 0x00efff, 1.8)
    const dash = mat(level.theme === 'drift' ? 0xff6bd9 : 0xe8f5ff, level.theme === 'drift' ? 0xff2bb5 : 0x8defff, 1.6, 0.4)
    const seg = 12
    for (let progress = -18; progress < level.length + 24; progress += seg) {
      const z = -progress - seg / 2
      const center = this.trackPoint(progress + seg / 2)
      const heading = this.trackHeading(progress + seg / 2)
      const road = box(new THREE.Vector3(level.roadWidth, 0.22, seg + 0.16), asphalt)
      road.position.set(center.x, -0.16, center.z)
      road.rotation.y = heading
      this.road.add(road)
      const left = box(new THREE.Vector3(0.16, 0.05, seg), edge)
      left.position.set(center.x - level.roadWidth / 2 + 0.24, 0.02, z)
      left.rotation.y = heading
      this.road.add(left)
      const right = left.clone()
      right.position.x = center.x + level.roadWidth / 2 - 0.24
      this.road.add(right)
      if (Math.floor(progress / seg) % 2 === 0) {
        const lane = box(new THREE.Vector3(0.1, 0.035, 4.2), dash)
        lane.position.set(center.x, 0.025, z)
        lane.rotation.y = heading
        this.road.add(lane)
      }
      const leftShoulder = box(new THREE.Vector3(1.6, 0.12, seg + 0.4), shoulder)
      leftShoulder.position.set(center.x - level.roadWidth / 2 - 0.9, -0.12, z)
      leftShoulder.rotation.y = heading
      this.road.add(leftShoulder)
      const rightShoulder = leftShoulder.clone()
      rightShoulder.position.x = center.x + level.roadWidth / 2 + 0.9
      this.road.add(rightShoulder)
    }
    const ground = box(new THREE.Vector3(360, 0.5, level.length + 220), mat(level.theme === 'city' ? 0x070815 : 0x0a1016, 0x010205, 0.1, 1))
    ground.position.set(0, -0.48, -level.length / 2)
    this.road.add(ground)
  }

  private createEnvironment(level: Level): void {
    const cyan = neon(0x00efff, 2.6)
    const magenta = neon(0xff2bb5, 2.6)
    const mountainMat = mat(level.theme === 'city' ? 0x101229 : 0x122535, 0x04101c, 0.25, 1)
    const towerMats = [mat(0x101936, 0x101750, 0.8, 0.8), mat(0x1b123b, 0x291064, 1, 0.78), mat(0x10293c, 0x0b4c64, 0.9, 0.74)]
    for (let progress = 20; progress < level.length + 80; progress += 42) {
      const p = this.trackPoint(progress)
      const side = progress % 84 === 0 ? -1 : 1
      const offset = level.roadWidth / 2 + 12 + (progress % 3) * 4
      if (level.theme === 'city' || (level.theme === 'overdrive' && progress > level.length * 0.6)) {
        const tower = box(new THREE.Vector3(9 + (progress % 3) * 2, 18 + (progress % 5) * 6, 9), towerMats[Math.floor(progress / 42) % towerMats.length])
        tower.position.set(p.x + side * offset, 8.6 + (progress % 5) * 3, p.z)
        this.road.add(tower)
        for (let y = 4; y < tower.scale.y + 10; y += 4) {
          const windowLine = box(new THREE.Vector3(7, 0.14, 0.08), side > 0 ? cyan : magenta)
          windowLine.position.set(tower.position.x, y, tower.position.z - 4.55)
          this.road.add(windowLine)
        }
      } else {
        const mountain = new THREE.Mesh(new THREE.ConeGeometry(10 + (progress % 3) * 5, 20 + (progress % 4) * 6, 7), mountainMat)
        mountain.position.set(p.x + side * offset, 10, p.z)
        mountain.rotation.y = progress * 0.23
        mountain.castShadow = true
        this.road.add(mountain)
        if (progress % 84 === 20) {
          const tree = this.createTree()
          tree.position.set(p.x - side * (level.roadWidth / 2 + 4), 0, p.z)
          this.road.add(tree)
        }
      }
      if (level.theme === 'highway' || level.theme === 'overdrive') {
        const pole = new THREE.Group()
        const stem = box(new THREE.Vector3(0.12, 5.6, 0.12), mat(0x546177, 0x1a2538, 0.4, 0.4))
        stem.position.y = 2.8
        pole.add(stem)
        const lamp = box(new THREE.Vector3(1.4, 0.08, 0.2), cyan)
        lamp.position.set(side * 0.65, 5.55, 0)
        pole.add(lamp)
        pole.position.set(p.x + side * (level.roadWidth / 2 + 3.5), 0, p.z)
        this.road.add(pole)
      }
      if (level.theme === 'city' && progress % 126 === 0) {
        const sign = box(new THREE.Vector3(4.5, 2.2, 0.12), progress % 252 === 0 ? magenta : cyan)
        sign.position.set(p.x + (side > 0 ? -1 : 1) * (level.roadWidth / 2 + 2), 4.7, p.z - 5)
        sign.rotation.y = side > 0 ? -0.2 : 0.2
        this.road.add(sign)
      }
    }
    const moon = new THREE.Mesh(new THREE.SphereGeometry(10, 18, 12), new THREE.MeshBasicMaterial({ color: 0xa4dfff, transparent: true, opacity: 0.14, depthWrite: false }))
    moon.position.set(-90, 78, -210)
    this.road.add(moon)
  }

  private createTree(): THREE.Group {
    const tree = new THREE.Group()
    const trunk = box(new THREE.Vector3(0.35, 2.6, 0.35), mat(0x2a1c21, 0x050204, 0.1, 1))
    trunk.position.y = 1.3
    tree.add(trunk)
    const crown = new THREE.Mesh(new THREE.ConeGeometry(1.7, 4.8, 7), mat(0x0c4a4b, 0x013336, 0.65, 0.92))
    crown.position.y = 4
    tree.add(crown)
    return tree
  }

  private createCheckpoints(level: Level): void {
    const checkpointMat = neon(level.theme === 'drift' ? 0xff2bb5 : 0x00efff, 2.8)
    for (let i = 1; i <= 5; i++) {
      const progress = Math.round(level.length * (i / 6))
      this.checkpoints.push(progress)
      const p = this.trackPoint(progress)
      const gate = new THREE.Group()
      const postL = box(new THREE.Vector3(0.22, 5.6, 0.22), checkpointMat)
      postL.position.set(-level.roadWidth / 2 + 0.65, 2.8, 0)
      gate.add(postL)
      const postR = postL.clone()
      postR.position.x *= -1
      gate.add(postR)
      const top = box(new THREE.Vector3(level.roadWidth - 1.1, 0.25, 0.24), checkpointMat)
      top.position.y = 5.45
      gate.add(top)
      gate.position.set(p.x, 0, p.z)
      gate.rotation.y = this.trackHeading(progress)
      this.road.add(gate)
    }
  }

  private createFinishLine(level: Level): void {
    const p = this.trackPoint(level.length)
    const finish = new THREE.Group()
    const line = box(new THREE.Vector3(level.roadWidth, 0.05, 1.8), neon(0xfff7b0, 2.5))
    line.position.y = 0.1
    finish.add(line)
    const banner = box(new THREE.Vector3(level.roadWidth, 1.25, 0.16), neon(0xff2bb5, 2.8))
    banner.position.y = 5.4
    finish.add(banner)
    for (const x of [-level.roadWidth / 2 + 0.7, level.roadWidth / 2 - 0.7]) {
      const pillar = box(new THREE.Vector3(0.3, 5.5, 0.3), neon(0x00efff, 2.8))
      pillar.position.set(x, 2.75, 0)
      finish.add(pillar)
    }
    finish.position.set(p.x, 0, p.z)
    finish.rotation.y = this.trackHeading(level.length)
    this.road.add(finish)
  }

  private createRivals(level: Level): void {
    const colors = [0xff2bb5, 0xff5b3d, 0xb4ff4d, 0xffd35c, 0x9d7dff]
    for (let i = 0; i < 5; i++) {
      const root = this.createCar(colors[i], 0x00efff)
      const progress = -4 - i * 5
      const lane = (i % 3 - 1) * (level.roadWidth * 0.22)
      this.actors.add(root)
      this.rivals.push({ root, progress, lane, speed: level.aiSpeed + (i % 2) * 2 - 1.5, phase: i * 1.7 })
    }
  }

  private createTraffic(level: Level): void {
    const colors = [0x5a6a83, 0x983b56, 0x2b9b9d, 0xb5a056]
    for (let i = 0; i < level.traffic; i++) {
      const root = this.createCar(colors[i % colors.length], 0x536a8e, 0.86)
      const progress = 70 + i * 74
      const lane = (i % 4 - 1.5) * (level.roadWidth * 0.18)
      this.actors.add(root)
      this.traffic.push({ root, progress, lane, speed: 18 + (i % 3) * 4, phase: i * 1.3 })
    }
  }

  private createPlayerCar(): void {
    this.player.clear()
    if (this.generatedCar) {
      const visual = this.generatedCar.clone(true)
      const bounds = new THREE.Box3().setFromObject(visual)
      const size = bounds.getSize(new THREE.Vector3())
      const fit = 4.15 / Math.max(size.x, size.z, 0.1)
      visual.scale.setScalar(fit)
      visual.position.y = -bounds.min.y * fit + 0.02
      visual.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true
          object.receiveShadow = true
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          for (const material of materials) {
            if (material instanceof THREE.MeshStandardMaterial) {
              material.color.lerp(new THREE.Color(this.currentCar.color), 0.42)
              material.emissive.lerp(new THREE.Color(this.currentCar.accent), 0.24)
              material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.24)
            }
          }
        }
      })
      this.player.add(visual)
      this.playerWheels = []
      this.playerGlow = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: this.currentCar.accent, transparent: true, opacity: 0.9, depthWrite: false }))
      this.playerGlow.position.set(0, 0.6, 2.3)
      this.playerGlow.scale.set(1.8, 0.45, 0.55)
      this.playerGlow.visible = false
      this.player.add(this.playerGlow)
      return
    }
    const car = this.createCar(this.currentCar.color, this.currentCar.accent, 1)
    this.player.add(car)
    this.playerWheels = car.userData.wheels as THREE.Mesh[]
    this.playerGlow = car.userData.glow as THREE.Mesh
  }

  private async loadGeneratedCar(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(GENERATED_CAR_URL)
      this.generatedCar = gltf.scene
      this.createPlayerCar()
    } catch {
      // The procedural neon car remains a complete fallback when a saved preview cannot reach Storage.
    }
  }

  private createCar(color: number, accent: number, scale = 1): THREE.Group {
    const root = new THREE.Group()
    root.scale.setScalar(scale)
    const body = box(new THREE.Vector3(2.1, 0.55, 4.25), mat(color, color, 0.16, 0.28))
    body.position.y = 0.78
    root.add(body)
    const hood = box(new THREE.Vector3(1.85, 0.25, 1.25), mat(color, color, 0.2, 0.25))
    hood.position.set(0, 1.08, -1.05)
    root.add(hood)
    const cabin = new THREE.Mesh(new THREE.CapsuleGeometry(0.78, 1.15, 4, 10), new THREE.MeshStandardMaterial({ color: 0x08111d, metalness: 0.4, roughness: 0.2, emissive: 0x06142b, emissiveIntensity: 0.75 }))
    cabin.scale.set(1.03, 0.58, 1.12)
    cabin.rotation.x = Math.PI / 2
    cabin.position.set(0, 1.3, 0.22)
    cabin.castShadow = true
    root.add(cabin)
    const sill = neon(accent, 2.6)
    for (const side of [-1, 1]) {
      const strip = box(new THREE.Vector3(0.08, 0.08, 3.6), sill)
      strip.position.set(side * 1.02, 0.72, 0)
      root.add(strip)
    }
    const head = neon(0xe7fbff, 3.4)
    for (const side of [-1, 1]) {
      const lamp = box(new THREE.Vector3(0.48, 0.12, 0.08), head)
      lamp.position.set(side * 0.66, 0.97, -2.11)
      root.add(lamp)
      const tail = box(new THREE.Vector3(0.48, 0.12, 0.08), neon(0xff234f, 3.1))
      tail.position.set(side * 0.66, 0.93, 2.11)
      root.add(tail)
    }
    const wheels: THREE.Mesh[] = []
    for (const x of [-1.08, 1.08]) for (const z of [-1.35, 1.35]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.23, 14), mat(0x07090e, 0x000000, 0.05, 0.9))
      wheel.rotation.z = Math.PI / 2
      wheel.position.set(x, 0.48, z)
      wheel.castShadow = true
      root.add(wheel)
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.24, 10), mat(accent, accent, 0.7, 0.25))
      rim.rotation.z = Math.PI / 2
      rim.position.copy(wheel.position)
      root.add(rim)
      wheels.push(wheel)
    }
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: 0x00efff, transparent: true, opacity: 0.9, depthWrite: false }))
    glow.position.set(0, 0.6, 2.3)
    glow.scale.set(1.8, 0.45, 0.55)
    glow.visible = false
    root.add(glow)
    root.userData.wheels = wheels
    root.userData.glow = glow
    return root
  }

  private updatePlayer(dt: number): void {
    const throttle = this.held('KeyW') || this.held('ArrowUp')
    const brake = this.held('KeyS') || this.held('ArrowDown')
    const steer = (this.held('KeyA') || this.held('ArrowLeft') ? -1 : 0) + (this.held('KeyD') || this.held('ArrowRight') ? 1 : 0)
    const handbrake = this.held('Space')
    const boosting = this.held('ShiftLeft') || this.held('ShiftRight')
    if (this.just('KeyE')) {
      this.cameraMode = this.cameraMode === 'chase' ? 'hood' : 'chase'
      this.notify(this.cameraMode === 'hood' ? 'HOOD CAM // LOCKED' : 'CHASE CAM // LOCKED', 'info')
    }
    if (this.just('KeyC')) {
      this.cameraMode = this.cameraMode === 'rear' ? 'chase' : 'rear'
      this.notify(this.cameraMode === 'rear' ? 'REAR VIEW // WATCH YOUR SIX' : 'CHASE CAM // LOCKED', 'info')
    }
    if (this.just('KeyR')) {
      this.resetPlayer()
      this.notify('RECOVERY // BACK ON LINE', 'warning')
    }
    const speedLimit = this.currentCar.maxSpeed + (boosting && this.nitro > 0 ? 19 : 0)
    if (throttle) this.speed += this.currentCar.acceleration * dt
    else this.speed -= Math.sign(this.speed) * (handbrake ? 1.5 : 3.8) * dt
    if (brake) {
      if (this.speed > 1.2) this.speed -= 34 * dt
      else this.speed -= 13 * dt
    }
    if (boosting && throttle && this.nitro > 0 && this.speed > 6) {
      this.speed += 28 * dt
      this.nitro = clamp(this.nitro - 28 * dt, 0, this.currentCar.nitro)
    } else {
      this.nitro = clamp(this.nitro + (handbrake ? 5 : 8) * dt, 0, this.currentCar.nitro)
    }
    if (!throttle && !brake && Math.abs(this.speed) < 0.6) this.speed = 0
    this.speed = clamp(this.speed, -15, speedLimit)
    const steerPower = this.currentCar.handling * (0.24 + Math.min(1, Math.abs(this.speed) / 18)) * (handbrake ? 1.55 : 1)
    this.yaw += steer * steerPower * dt * (this.speed >= 0 ? 1 : -1)
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    this.player.position.addScaledVector(forward, this.speed * dt)
    this.player.rotation.y = this.yaw
    const center = this.trackPoint(Math.max(0, -this.player.position.z))
    const lateral = this.player.position.x - center.x
    const roadLimit = this.currentLevel.roadWidth / 2 - 1.15
    if (Math.abs(lateral) > roadLimit) {
      this.speed *= Math.pow(0.13, dt)
      this.player.position.x = damp(this.player.position.x, center.x + clamp(lateral, -roadLimit - 2, roadLimit + 2), 3, dt)
      if (Math.abs(lateral) > this.currentLevel.roadWidth / 2 + 2.5) this.resetPlayer()
    }
    if (Math.abs(this.speed) > 7 && handbrake && Math.abs(steer) > 0) {
      this.driftScore += Math.abs(this.speed) * (0.8 + Math.abs(steer)) * dt * 2.4
      this.skidClock += dt
      if (this.skidClock > 0.065) {
        this.addSkidMark()
        this.skidClock = 0
      }
    } else this.skidClock = 0
    const progress = clamp(-this.player.position.z, 0, this.currentLevel.length)
    while (this.state.checkpoint < this.checkpoints.length && progress >= this.checkpoints[this.state.checkpoint]) {
      this.state.checkpoint += 1
      this.notify(`CHECKPOINT ${this.state.checkpoint} / ${this.checkpoints.length}`, 'success')
    }
    this.state.progress = progress / this.currentLevel.length
    this.state.speedKmh = Math.round(Math.abs(this.speed) * 3.6)
    this.state.gear = this.speed < -0.5 ? 'R' : this.speed < 1 ? 'N' : String(clamp(Math.floor(this.speed / 10) + 1, 1, 6))
    this.state.rpm = Math.round(clamp((Math.abs(this.speed) / speedLimit) * 100, 0, 100))
  }

  private updateRivals(dt: number): void {
    for (const rival of this.rivals) {
      rival.progress += rival.speed * dt
      const p = this.trackPoint(rival.progress)
      const heading = this.trackHeading(rival.progress)
      rival.root.position.set(p.x + rival.lane + Math.sin(this.raceTime * 0.8 + rival.phase) * 0.35, 0.62, p.z)
      rival.root.rotation.y = heading
    }
  }

  private updateTraffic(dt: number): void {
    for (const vehicle of this.traffic) {
      vehicle.progress += vehicle.speed * dt
      if (vehicle.progress > this.currentLevel.length + 30) vehicle.progress = -35 - vehicle.phase * 3
      const p = this.trackPoint(vehicle.progress)
      vehicle.root.position.set(p.x + vehicle.lane, 0.58, p.z)
      vehicle.root.rotation.y = this.trackHeading(vehicle.progress)
    }
  }

  private updateRaceState(): void {
    const progress = clamp(-this.player.position.z, 0, this.currentLevel.length)
    const ahead = this.rivals.filter(rival => rival.progress > progress).length
    this.state.position = clamp(ahead + 1, 1, this.state.racers)
    if (progress >= this.currentLevel.length - 2) {
      this.finish(true)
    } else if (this.raceTime >= this.currentLevel.timeLimit) {
      this.finish(false)
    }
  }

  private finish(won: boolean): void {
    if (this.state.mode === 'finished') return
    this.state.mode = 'finished'
    this.state.countdown = ''
    this.state.timer = Math.min(this.raceTime, this.currentLevel.timeLimit)
    this.state.message = won ? 'FINISH // SYSTEM OVERDRIVE' : 'TIMEOUT // RUN ENDED'
    this.tutorialShown = true
    if (this.currentLevel.id === 1) this.hooks.saveTutorial()
    const result: RaceResult = { levelId: this.currentLevel.id, won, position: this.state.position, time: this.raceTime, bestTime: null, driftScore: Math.floor(this.driftScore) }
    this.finishedResult = result
    this.hooks.finish(result)
  }

  private resetPlayer(): void {
    const progress = Math.max(0, this.state.checkpoint > 0 ? this.checkpoints[this.state.checkpoint - 1] - 7 : 0)
    const p = this.trackPoint(progress)
    this.player.position.set(p.x, 0.62, p.z)
    this.yaw = this.trackHeading(progress)
    this.player.rotation.y = this.yaw
    this.speed = 0
  }

  private updateCamera(dt: number): void {
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    const behind = forward.clone().multiplyScalar(-1)
    let desired: THREE.Vector3
    let look: THREE.Vector3
    if (this.cameraMode === 'hood') {
      desired = this.player.position.clone().addScaledVector(forward, 1.1).add(new THREE.Vector3(0, 1.55, 0))
      look = desired.clone().addScaledVector(forward, 26).add(new THREE.Vector3(0, 0.4, 0))
    } else if (this.cameraMode === 'rear') {
      desired = this.player.position.clone().addScaledVector(forward, -5.5).add(new THREE.Vector3(0, 3.4, 0))
      look = desired.clone().addScaledVector(behind, 24)
    } else {
      desired = this.player.position.clone().addScaledVector(behind, 8.3 + Math.min(4, Math.abs(this.speed) * 0.06)).add(new THREE.Vector3(0, 4.1, 0))
      look = this.player.position.clone().addScaledVector(forward, 17).add(new THREE.Vector3(0, 1.1, 0))
    }
    if (this.state.mode === 'menu') {
      desired = new THREE.Vector3(10 + Math.sin(this.attractTime * 0.15) * 2, 6.2, 13 + Math.cos(this.attractTime * 0.15) * 2)
      look = new THREE.Vector3(0, 1, -24)
    }
    this.camera.position.lerp(desired, 1 - Math.exp(-7 * dt))
    this.camera.lookAt(look)
    this.camera.fov = damp(this.camera.fov, this.cameraMode === 'hood' ? 72 : 62 + Math.min(9, Math.abs(this.speed) * 0.08), 4, dt)
    this.camera.updateProjectionMatrix()
  }

  private addSkidMark(): void {
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 1.25), new THREE.MeshBasicMaterial({ color: 0x03040a, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide }))
    mark.rotation.x = -Math.PI / 2
    mark.rotation.y = this.yaw
    mark.position.copy(this.player.position)
    mark.position.y = 0.02
    mark.position.x += (Math.random() - 0.5) * 1.4
    this.effects.add(mark)
    if (this.effects.children.length > 120) this.effects.children[0].removeFromParent()
  }

  private trackPoint(progress: number): THREE.Vector3 {
    const p = clamp(progress, -30, this.currentLevel.length + 80)
    const x = this.trackCenter(p)
    return new THREE.Vector3(x, 0, -p)
  }

  private trackCenter(progress: number): number {
    const t = progress
    switch (this.currentLevel.theme) {
      case 'mountain': return Math.sin(t * 0.010) * 8 + Math.sin(t * 0.027) * 2.1
      case 'highway': return Math.sin(t * 0.005) * 4 + Math.sin(t * 0.013) * 1.3
      case 'city': return Math.sin(t * 0.015) * 6 + Math.sin(t * 0.041) * 1.2
      case 'drift': return Math.sin(t * 0.017) * 10 + Math.sin(t * 0.043) * 3.5
      case 'overdrive': return Math.sin(t * 0.009) * 7 + Math.sin(t * 0.022) * 2.2 + (t > this.currentLevel.length * 0.62 ? Math.sin(t * 0.018) * 4 : 0)
    }
  }

  private trackHeading(progress: number): number {
    const ahead = this.trackCenter(progress + 2)
    const here = this.trackCenter(progress - 2)
    return Math.atan2(-(ahead - here) / 4, 1)
  }

  private bindInput(): void {
    window.addEventListener('keydown', event => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault()
      if (!event.repeat) this.input.justPressed.add(event.code)
      this.input.keys.add(event.code)
      if (event.code === 'Escape' && (this.state.mode === 'racing' || this.state.mode === 'countdown')) this.setPaused(true)
      else if (event.code === 'Escape' && this.state.mode === 'paused') this.setPaused(false)
    })
    window.addEventListener('keyup', event => this.input.keys.delete(event.code))
    window.addEventListener('blur', () => this.input.keys.clear())
  }

  private held(code: string): boolean { return this.input.keys.has(code) }
  private just(code: string): boolean {
    const result = this.input.justPressed.has(code)
    this.input.justPressed.delete(code)
    return result
  }

  private notify(message: string, kind: 'info' | 'success' | 'warning' = 'info'): void {
    if (message === this.lastNotify) return
    this.lastNotify = message
    this.state.message = message
    this.hooks.notify(message, kind)
  }
}

export function attachLighting(scene: THREE.Scene): void {
  if (scene.getObjectByName('ambient')) return
  const hemi = new THREE.HemisphereLight(0x405d98, 0x080a12, 1.6)
  hemi.name = 'ambient'
  scene.add(hemi)
  const moon = new THREE.DirectionalLight(0xa9c9ff, 2.2)
  moon.position.set(-50, 75, 35)
  moon.castShadow = true
  moon.shadow.mapSize.set(1024, 1024)
  moon.shadow.camera.left = -90
  moon.shadow.camera.right = 90
  moon.shadow.camera.top = 90
  moon.shadow.camera.bottom = -90
  scene.add(moon)
  const cyan = new THREE.PointLight(0x00efff, 18, 40, 2)
  cyan.position.set(-12, 6, 6)
  scene.add(cyan)
  const magenta = new THREE.PointLight(0xff2bb5, 14, 36, 2)
  magenta.position.set(16, 4, -18)
  scene.add(magenta)
}

export function createRacerGame(renderer: Renderer, hooks: RacerHooks): RacerGame {
  const game = new RacerGame(renderer, hooks)
  attachLighting(game.scene)
  return game
}
