# POCKET RACER

A PlayStation-era style low-poly arcade racing game, built with TypeScript + Vite + Three.js + cannon-es.

All assets (car bodies, tracks, textures, music and sound) are generated procedurally from primitives, Canvas and WebAudio — there are no external model, image or audio files.

## Modes

On launch you pick a mode:

- **ARCADE** — choose a difficulty, then race a fixed series of 4 courses back-to-back. Finish in the top 3 each race to advance; 4th or lower is game over.
- **FREE RUN** — pick your car and any single course for a one-off race.

You choose your car from 5 machines (each with its own handling), and the 4 cars you don't pick race you as AI rivals (5 cars total).

## Setup

Requires Node.js 18+.

```bash
npm install
npm run dev      # dev server (http://localhost:5173)
npm run build    # production build (dist/)
npm run preview  # preview the build
```

## Controls

Left hand (Z/X) for throttle and brake, right hand (← →) for steering.

| Key | Action |
|-----|--------|
| Z | Accelerate |
| X | Brake / reverse |
| ← → | Steer (→ right, ← left) |
| C | Switch camera (chase / overhead / hood) |
| Esc | Pause |
| M | Mute engine sound & music |

Complete the required laps to finish. Driving the wrong way shows `WRONG WAY`.

## Drifting

Hold **accelerate (Z)** and keep steering: after a short "charge" (~0.5–1s, faster the quicker you go) the rear breaks loose into a sustained drift (it does not drift instantly). During a drift you sculpt the angle with steering:

- Keep steering into the drift → the angle deepens (more sideways, sharper turn).
- Counter-steer → flick to the other side (linked S-turns).
- Ease off the steering → recover to normal driving.

While drifting the camera swings behind your direction of travel — you keep heading straight down the screen while the body rotates sideways. The car only turns while you hold the throttle; releasing it stops the turn, holds your speed and gradually recovers grip.

## Feel tuning (CarTuning.ts)

All of the car's "feel" lives in **`src/CarTuning.ts`** (no magic numbers scattered in code). Values are mutable, so during development you can tweak them live from the browser console:

```js
CarTuning.EnginePower = 1000   // stronger acceleration
CarTuning.DriftAngleMax = 55   // deeper drift angle
```

Main groups: acceleration (`EnginePower / MaxSpeed / BrakePower`), steering (`MaxSteeringAngle / SteeringSpeed`), grip, sustained-drift parameters (`DriftSpeedThreshold`, `DriftEngageTime*`, `DriftAngleMax`, `DriftBuildRate`, `DriftExitAngle`, `DriftTurnRate` …) and camera/presentation.

## Project layout

| File | Role |
|------|------|
| `src/main.ts` | Entry point, mode / car / course selection UI |
| `src/Game.ts` | Orchestration, game loop, race state machine, standings & results |
| `src/RaceTrack.ts` | Shared course interface (`TrackId`, centerline, surface, elevation …) |
| `src/Track*.ts` | The 10 courses |
| `src/Car.ts` | RaycastVehicle + arcade handling (drift / assists / presentation) |
| `src/CarRoster.ts` | The 5 selectable cars (looks & performance multipliers) |
| `src/AIDriver.ts` | Rival line-following AI |
| `src/CarTuning.ts` | All car / camera / transmission feel values (mutable) |
| `src/Constants.ts` | Structural values (rendering, lights, camera, course dimensions, colors) |
| `src/Physics.ts` | cannon-es physics world |
| `src/AssetGenerator.ts` | Procedural car / wheel / texture generation |
| `src/CameraController.ts` | Three cameras + speed presentation |
| `src/HUD.ts` | Standings, lap & race timing, minimap, tacho |
| `src/EngineSound.ts` | Synthesized engine sound & SFX (WebAudio) |
| `src/MusicPlayer.ts` / `src/MusicTracks.ts` | Original synthesized BGM (seamless looping) |
| `src/TireSmoke.ts` | Drift / spin smoke |

> Drive / steer direction depends on cannon-es axis conventions. If it inverts,
> flip `DRIVE_SIGN` / `STEER_INPUT_SIGN` in `src/Car.ts`.
