import * as THREE from "three";
import { RENDER, LIGHT, TRACK, RACE } from "./Constants";
import { Input, type InputState } from "./Input";
import { Physics } from "./Physics";
import { Track, type Checkpoint } from "./Track";
import { TrackBeginner } from "./TrackBeginner";
import { TrackTunnel } from "./TrackTunnel";
import { TrackTunnelLong } from "./TrackTunnelLong";
import { TrackHighland } from "./TrackHighland";
import { TrackTouge } from "./TrackTouge";
import { TrackForest } from "./TrackForest";
import { TrackCircuit } from "./TrackCircuit";
import { TrackSuzuka } from "./TrackSuzuka";
import { TrackShutoko } from "./TrackShutoko";
import type { RaceTrack, TrackId } from "./RaceTrack";
import { Car } from "./Car";
import { AIDriver } from "./AIDriver";
import { CAR_ROSTER, getCarSpec, type CarSpec } from "./CarRoster";
import { CameraController } from "./CameraController";
import { EngineSound } from "./EngineSound";
import { music, type MusicTrackId } from "./MusicPlayer";
import { isMuted, toggleGlobalMuted } from "./AudioMute";
import { HUD } from "./HUD";

/**
 * アーケードモードの文脈（4コース連戦・毎回3位以内が目標）。
 * フリーランでは null。Game はこれを使ってリザルト画面をアーケード用に切り替える。
 */
export interface ArcadeContext {
  /** 何コース目か（0始まり） */
  courseIndex: number;
  /** 総コース数（=4） */
  totalCourses: number;
}

/** リザルト後に main.ts が読む、このコースの結果（アーケード時のみ） */
export interface ArcadeOutcome {
  /** プレイヤーの最終順位（1始まり） */
  position: number;
  /** 4位以下＝ゲームオーバー（次コースへ進めない） */
  gameOver: boolean;
  /** 最終コースだった */
  isFinal: boolean;
}

/** レースの進行状態 */
enum RaceState {
  /** スタート前カウントダウン */
  Countdown,
  /** 走行中 */
  Racing,
  /** （プレイヤーが）ゴール済み */
  Finished,
}

/**
 * ライバル AI の腕前（自身の最高速倍率に掛ける）。
 * 1.0 で「各車が自分の最高速をきちんと使い切る」＝プレイヤーと互角に近い勝負。
 * （以前は 0.9 で全車が一律に遅く、勝負にならなかった）
 */
const AI_SKILL = 1.0;

/** AI 車だけの隠しブースト（プレイヤーは不変）。grip は AIDriver の cornerGrip にも渡す。 */
interface AiBoost {
  grip: number;
  steer: number;
  top: number;
  accel: number;
  /** applyStability のヨーレート上限の倍率（急コーナーの実際の旋回力。省略時1） */
  yaw?: number;
  /** AIDriver の操舵先読み距離の倍率（省略時1）。クネクネ道で <1 にすると流れる */
  steerLead?: number;
}

/**
 * コースごとの AI ブースト量。人間はドリフトでコーナーも最高速近くを維持できるため、
 * **タイトコーナーが多いコースほど AI は不利**＝強めにブーストして人間に追従させる。
 * 逆に**コーナーが少ない／単純なコースはマシン性能がそのまま出る**ので、ブーストは弱め〜無し
 * （オーバルは「インチキ無し」のリクエストどおり素の性能で走らせる）。
 */
/**
 * コース → BGM。tunnel と tunnelLong は同じ地下高速の曲を共有する
 * （計 8 曲：メニュー＋7 コース曲。MusicTracks.ts 参照）。
 */
function musicForTrack(trackId: TrackId): MusicTrackId {
  switch (trackId) {
    case "tunnel":
    case "tunnelLong":
      return "tunnel";
    case "beginner":
      return "beginner";
    case "highland":
      return "highland";
    case "touge":
      return "touge";
    case "forest":
      return "forest";
    case "circuit":
      return "circuit";
    case "suzuka":
      // スズカ・スペシャル専用のグランプリ・テーマ。
      return "suzuka";
    case "shutoko":
      // 夜の都市高速＝オーバルの「NEON HIGHWAY」を共有（曲名どおりの雰囲気）。
      return "oval";
    default:
      return "oval";
  }
}

function aiBoostFor(trackId: TrackId): AiBoost {
  switch (trackId) {
    case "oval":
      // 高速オーバル：マシン性能がそのまま出る。ブースト無し（インチキ無し）。
      return { grip: 1, steer: 1, top: 1, accel: 1 };
    case "beginner":
      // 初級サーキット：プレイヤー(ロッドライオン)実測 ~30秒/周に対し、
      // ライバルは +5秒前後（~35秒）になるよう控えめにブースト。
      return { grip: 1.4, steer: 1.08, top: 1.0, accel: 1.05 };
    case "tunnel":
      // 長い直線＋右下に急な直角コーナー1つ（半径≈15m）。直線は流せるが、
      // 急コーナーを曲がり切れるだけのグリップ／舵角は要る（詰まり防止）。
      // 直角1つ分だけ beginner より強め・tunnelLong よりは弱めに。
      return { grip: 2.6, steer: 1.4, top: 1.0, accel: 1.1 };
    case "circuit":
      // 良い感じだったので、ほんの少しだけ弱める。
      return { grip: 3.0, steer: 1.5, top: 1.06, accel: 1.25 };
    case "suzuka":
      // スズカ・スペシャル：長距離でエッセス／ヘアピン／シケインなどテクニカル。
      // GRAND CIRCUIT 相当のブーストに、長い直線ぶん最高速を少しだけ盛る。
      return { grip: 3.0, steer: 1.5, top: 1.08, accel: 1.25 };
    case "highland":
      // ダートの狭いコース（緩い流れ＋最終ヘアピン1つ）。以前は default（強め）で
      // 「速すぎ」だったので、最高速・加速を素の値近くまで落とし、グリップも控えめに
      // （コーナーで詰まらない程度には残す）。タイトコーナーがある分 steer は少しだけ盛る。
      return { grip: 2.2, steer: 1.3, top: 1.0, accel: 1.05 };
    case "forest":
      // 同じダートだが、急な直角コーナーが3箇所あるテクニカルコース。
      // 低グリップ(0.6)で直角を曲がり切れるよう highland より grip/steer を上乗せ。
      // 直線は短めなので最高速は据え置き（決定論検証で全4台完走・詰まり最小に調整）。
      return { grip: 3.4, steer: 1.55, top: 1.0, accel: 1.12 };
    case "touge":
      // 峠ロング：以前は default（強め）で「速すぎ」だったので少し落とす。
      // 最高速・加速を控えめにしつつ、ヘアピン/吊り橋後の急コーナーで詰まらない
      // 程度のグリップ・舵角は残す（tunnelLong ほど狭くないので default よりは弱め）。
      return { grip: 3.0, steer: 1.5, top: 1.06, accel: 1.2 };
    case "shutoko":
      // 首都高：クネクネの連続コーナーが大半の高架。鍵は steerLead（操舵先読みの短縮）＝
      // これが1のままだと狭いS字で「目標点がコーナーをショートカット→大きくズレてブレーキ」
      // の振動に陥り10m/s前後で這う（grip/yaw をいくら盛っても逆効果＝計測済み）。
      // yaw（ヨー上限）も grip と同値に上げて「実際に曲がれる」ようにする。
      // プレイヤー実測 ~55s/周（レッドライオン）に対しライバル最速 +5s 前後（lap2≈60.6s、
      // 隊列 60.6〜65.8s・詰まり0）に調整。top は 1.04 と控えめ＝直線のインチキが目立たない。
      return { grip: 2.9, steer: 1.5, top: 1.04, accel: 1.25, yaw: 2.9, steerLead: 0.6 };
    default:
      // 非常にタイト（tunnelLong）：強めを維持。
      return { grip: 4.0, steer: 1.75, top: 1.13, accel: 1.4 };
  }
}
/** グリッドの前後間隔(m) */
const GRID_ROW_SPACING = 7;

/** 1台分のレース状態（プレイヤー/ライバル共通） */
interface Entrant {
  spec: CarSpec;
  car: Car;
  /** プレイヤーは null */
  ai: AIDriver | null;
  lap: number; // 1始まり（HUD表示・ゴール判定用）
  nextCheckpointIdx: number;
  lastCheckpoint: Checkpoint;
  // 順位計算（中心線の弧長を連続化）
  arcLaps: number; // 弧長の周回数（スタート線手前から始まるため初期 -1 もあり得る）
  prevArc: number; // 前フレームの弧長（ラップ跨ぎ検出用）
  progress: number; // 総走行距離（順位ソート用）
  finished: boolean;
  finishOrder: number; // 0=未ゴール
  finishTime: number; // ゴール時のレースタイム(秒)。未ゴールは0
  stuckTimer: number; // コース外で停止している時間(秒)。AIの自動復帰に使う
}

/**
 * ゲーム全体を統括するクラス。
 * シーン/物理/コース/車（プレイヤー＋ライバル）/カメラ/HUD を保持し、
 * 固定的なゲームループとレース状態機械を回す。
 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly clock = new THREE.Clock();

  private readonly physics: Physics;
  private readonly track: RaceTrack;
  private readonly aiBoost: AiBoost;
  private readonly cameraCtrl: CameraController;
  private readonly input: Input;
  private readonly hud: HUD;
  private readonly engineSound = new EngineSound();
  private audioStarted = false;
  /** このコースの BGM */
  private readonly musicId: MusicTrackId;

  // --- 出場車 ---
  private readonly entrants: Entrant[] = [];
  private readonly player: Entrant;

  // --- 順位計算（中心線の弧長）---
  private readonly cumLen: number[] = [];
  private trackLength = 0;
  private finishCount = 0;

  // --- レース状態 ---
  private state: RaceState = RaceState.Countdown;
  private paused = false;
  private countdown = RACE.COUNTDOWN_SEC;
  private lastCountN = 99; // 直近に効果音を鳴らしたカウント値（3→2→1 の検出用）
  private centerMsgTimer = 0; // GO!/GOAL! の残り表示時間

  // --- タイム計測 ---
  private raceTime = 0; // GO からの累計（レース全体の時計。リザルト表示で停止）
  private playerFinishTime = 0; // プレイヤーのゴールタイム（HUD表示は以後これで固定）
  private lapSplits: number[] = []; // プレイヤーの各周回タイム
  private lastLapTime = 0; // 直近ラップ確定時刻

  // --- リザルト ---
  private resultCountdown = 0; // ゴール後リザルトを出すまでの残り秒
  private resultShown = false;

  // --- アーケードモード ---
  private readonly arcade: ArcadeContext | null;
  /** リザルト確定後の結果（main.ts が次コース/ゲームオーバー判定に読む）。 */
  arcadeOutcome: ArcadeOutcome | null = null;

  private readonly tmpFlat = new THREE.Vector3();

  constructor(
    canvas: HTMLCanvasElement,
    trackId: TrackId = "oval",
    playerSpecId = "lion",
    arcade: ArcadeContext | null = null
  ) {
    this.arcade = arcade;
    // --- レンダラ（低解像度風・アンチエイリアス無し） ---
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(RENDER.SKY_COLOR);

    // --- シーン & フォグ ---
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(RENDER.SKY_COLOR);
    this.scene.fog = new THREE.FogExp2(RENDER.SKY_COLOR, RENDER.FOG_DENSITY);
    this.setupLights(trackId);

    // --- ワールド構築（選択されたコースを生成）---
    this.physics = new Physics();
    this.track =
      trackId === "tunnel"
        ? new TrackTunnel(this.scene, this.physics)
        : trackId === "tunnelLong"
          ? new TrackTunnelLong(this.scene, this.physics)
          : trackId === "highland"
            ? new TrackHighland(this.scene, this.physics)
            : trackId === "touge"
              ? new TrackTouge(this.scene, this.physics)
              : trackId === "forest"
                ? new TrackForest(this.scene, this.physics)
                : trackId === "circuit"
                  ? new TrackCircuit(this.scene, this.physics)
                  : trackId === "suzuka"
                    ? new TrackSuzuka(this.scene, this.physics)
                    : trackId === "shutoko"
                      ? new TrackShutoko(this.scene, this.physics)
                      : trackId === "beginner"
                        ? new TrackBeginner(this.scene, this.physics)
                        : new Track(this.scene, this.physics);

    // 中心線の累積弧長（順位計算用）
    this.buildArcLengthTable();

    // --- カメラ / 入力 / HUD ---
    this.cameraCtrl = new CameraController(
      window.innerWidth / window.innerHeight
    );
    this.input = new Input();
    this.hud = new HUD();
    this.hud.setLap(1, TRACK.TOTAL_LAPS);

    // --- コース BGM を開始（メニュー曲から差し替え）---
    // 自動再生制限下でも、メニューでの操作で AudioContext は resume 済みのことが多い。
    // リロード直後（アーケードのコース間）は最初のキー入力で resume する。
    this.musicId = musicForTrack(trackId);
    music.play(this.musicId);

    // プレイヤーの車種に合わせてエンジン音色を設定（start 前に）
    // グローバルのミュート状態も反映（既定ミュート＝SND ボタンで解除するまで無音）
    this.engineSound.setMuted(isMuted());
    this.engineSound.setVoice(getCarSpec(playerSpecId).style);

    // --- 出場 5 台をグリッドに配置（AI ブーストはコースごとに変える）---
    this.aiBoost = aiBoostFor(trackId);
    this.player = this.buildEntrants(playerSpecId);
    this.hud.setPosition(1, this.entrants.length);

    // 路面（ダート等）を全車へ反映
    if (this.track.surface) {
      for (const e of this.entrants) e.car.setSurface(this.track.surface);
    }
    // 起伏（見た目の高さ）を全車へ反映（峠コースなど）
    if (this.track.elevationAt) {
      const fn = this.track.elevationAt.bind(this.track);
      for (const e of this.entrants) e.car.setElevation(fn);
    }

    // --- ミニマップ（右上）初期化 ---
    this.hud.setupMinimap(this.track.centerline);
    this.hud.setRaceTime(0);

    this.cameraCtrl.update(this.player.car.root, this.player.car.getDynamics(), 0, true);
    this.handleResize();
    window.addEventListener("resize", this.handleResize);
  }

  /**
   * 5 台を生成してスタートグリッドへ。
   * 並びは CAR_ROSTER の番号順でスタートに近い側から。プレイヤーは必ず最後尾。
   * 1台ずつ左右へ振りながら段々に後退させる（スタッガードグリッド）。
   */
  private buildEntrants(playerSpecId: string): Entrant {
    const playerSpec = getCarSpec(playerSpecId);
    const rivals = CAR_ROSTER.filter((c) => c.id !== playerSpec.id);
    // スロット0=スタートに最も近い。ライバルを番号順に、最後尾にプレイヤー。
    const gridSpecs: CarSpec[] = [...rivals, playerSpec];

    const S = this.track.getStartPosition();
    const lane = this.track.roadHalfWidth * 0.45;

    let player!: Entrant;
    gridSpecs.forEach((spec, slot) => {
      // スタートから**中心線に沿って**後退（直線でない始点でもコース内に収まる）。
      // 左右交互に振り、プレイヤー(最後尾)が最もスタートから遠い。
      const side = slot % 2 === 0 ? 1 : -1;
      const g = this.gridSlot(S, slot * GRID_ROW_SPACING, side * lane);
      const pos = new THREE.Vector3(g.x, S.y, g.z);
      const F = g.forward;

      const car = new Car(this.scene, this.physics, spec);
      car.reset(pos, F.clone());

      // 順位用の弧長を初期化。グリッドはスタート線の手前（弧長が最大寄り）に
      // 並ぶので、その場合は周回数を -1 から始めて progress を負にする
      // （＝まだ1周目に入っていない＝後方、を正しく表す）。
      const arc0 = this.arcAt(pos);
      const arcLaps0 = arc0 > this.trackLength * 0.5 ? -1 : 0;

      const isPlayer = spec.id === playerSpec.id;
      const ai = isPlayer
        ? null
        : new AIDriver(this.track.centerline, {
            // ライバルはレーンを少しずつずらして団子・重なりを避ける
            // （先読み距離より十分小さく＝発進や追従を邪魔しない量）
            laneOffset: (slot - (rivals.length - 1) / 2) * 1.4,
            // 腕前を少しずつ変えて隊列をばらけさせる（狭い道での団子・詰まりを抑える）。
            // 直線では最高速を使い切る（base 1.0）。slot で少しずつ散らして接戦に。
            speedFactor: spec.topSpeedMul * AI_SKILL * (1.0 + 0.04 * slot),
            gripMul: this.track.surface?.gripMul ?? 1,
            steerMul: spec.steerMul,
            // コーナー目標速度を隠しグリップブーストぶん強気にする（コースごと）
            cornerGrip: this.aiBoost.grip,
            steerLeadMul: this.aiBoost.steerLead ?? 1,
          });
      // AI 車だけコーナーを攻めるための隠しブースト（プレイヤーは不変・コースごと）
      if (ai) car.setAiBoost(this.aiBoost);

      const entrant: Entrant = {
        spec,
        car,
        ai,
        lap: 1,
        nextCheckpointIdx: 1,
        lastCheckpoint: this.track.checkpoints[0],
        arcLaps: arcLaps0,
        prevArc: arc0,
        progress: arcLaps0 * this.trackLength + arc0,
        finished: false,
        finishOrder: 0,
        finishTime: 0,
        stuckTimer: 0,
      };
      this.entrants.push(entrant);
      if (isPlayer) player = entrant;
    });
    return player;
  }

  /**
   * スタート位置から中心線に沿って back メートル後退し、進行方向左へ lateral だけ
   * ずらしたグリッド位置と、その地点の進行方向を返す。
   * 直線でない始点でも全車がコース内（路面上）に並ぶ。
   */
  private gridSlot(
    start: THREE.Vector3,
    back: number,
    lateral: number
  ): { x: number; z: number; forward: THREE.Vector3 } {
    const cl = this.track.centerline;
    const n = cl.length;
    // start に最も近い中心線 index
    let s = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = cl[i].x - start.x;
      const dz = cl[i].z - start.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        s = i;
      }
    }
    // back ぶん index 減少方向へ後退し、区間内で線形補間
    let idx = s;
    let remaining = back;
    let px = cl[s].x;
    let pz = cl[s].z;
    while (remaining > 1e-6) {
      const prev = (idx - 1 + n) % n;
      const segLen = cl[idx].distanceTo(cl[prev]);
      if (segLen >= remaining || segLen < 1e-6) {
        const t = segLen > 1e-6 ? remaining / segLen : 0;
        px = cl[idx].x + (cl[prev].x - cl[idx].x) * t;
        pz = cl[idx].z + (cl[prev].z - cl[idx].z) * t;
        idx = prev;
        break;
      }
      remaining -= segLen;
      idx = prev;
      px = cl[idx].x;
      pz = cl[idx].z;
    }
    // idx の進行方向（index 増加方向）
    const a = cl[(idx - 1 + n) % n];
    const b = cl[(idx + 1) % n];
    const forward = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    if (forward.lengthSq() > 1e-6) forward.normalize();
    // 進行方向の左へ lateral
    return { x: px + forward.z * lateral, z: pz - forward.x * lateral, forward };
  }

  /** 中心線の累積弧長テーブルを作る（順位＝総走行距離の計算に使う） */
  private buildArcLengthTable(): void {
    const pts = this.track.centerline;
    const n = pts.length;
    let cum = 0;
    for (let i = 0; i < n; i++) {
      this.cumLen.push(cum);
      cum += pts[i].distanceTo(pts[(i + 1) % n]);
    }
    this.trackLength = cum;
  }

  private setupLights(trackId: TrackId): void {
    // トンネルは地下＝やや暗め。屋外光を抑え、照明設備（発光メッシュ）を主役にする。
    // 首都高は夜の市街地＝トンネルより少し明るい青い月明かり＋街の照り返し。
    const tunnel = trackId === "tunnel" || trackId === "tunnelLong";
    const night = trackId === "shutoko";
    this.scene.add(
      new THREE.AmbientLight(
        tunnel ? 0x6b7280 : night ? 0x707a94 : LIGHT.AMBIENT_COLOR,
        tunnel ? 0.5 : night ? 0.7 : LIGHT.AMBIENT_INTENSITY
      )
    );
    const sun = new THREE.DirectionalLight(
      tunnel ? 0xaab0c0 : night ? 0x93a7cc : LIGHT.SUN_COLOR,
      tunnel ? 0.35 : night ? 0.5 : LIGHT.SUN_INTENSITY
    );
    sun.position.set(
      LIGHT.SUN_POSITION.x,
      LIGHT.SUN_POSITION.y,
      LIGHT.SUN_POSITION.z
    );
    this.scene.add(sun);
  }

  private handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(RENDER.RESOLUTION_SCALE);
    this.renderer.setSize(w, h, false);
    this.cameraCtrl.setAspect(w / h);
  };

  /** ゲーム開始 */
  start(): void {
    // メニュー操作（クリック）の直後なので AudioContext を起こせることが多い。
    // カウントダウンの効果音を鳴らすため、最初のキー入力を待たずに用意しておく。
    this.engineSound.start();
    this.renderer.setAnimationLoop(this.loop);
  }

  private loop = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.update(dt);
    this.renderer.render(this.scene, this.cameraCtrl.camera);
  };

  // ---- メイン更新 ----
  private update(dt: number): void {
    this.hud.updateFps(dt);

    // エッジ入力（ポーズ/リセット/カメラ/ミュート）は常に受け付ける
    const edge = this.input.consumeEdgeFlags();
    if (edge.pauseToggle) this.togglePause();
    if (edge.cameraToggle) this.cameraCtrl.toggle();
    if (edge.muteToggle) {
      // M キー / SND ボタンはエンジン音と BGM の両方をミュート/解除
      const m = toggleGlobalMuted();
      this.engineSound.setMuted(m);
      music.setMuted(m); // 解除時は保留中のコース曲もここから鳴り始める
      if (!m) {
        // 解除して初めて AudioContext を作る/再開する
        this.engineSound.start();
        this.engineSound.resume();
      }
    }

    // 自動再生制限のため、最初のキー入力でオーディオを確実に起こす。
    // start() は冪等（既に Game.start で開始済み）。リロード直後（アーケードの
    // コース間）は AudioContext が suspended のことがあるので resume＋再生を保証する。
    if (!this.audioStarted && this.input.anyKeyPressed && !isMuted()) {
      this.engineSound.start();
      this.engineSound.resume();
      music.resumeOnGesture();
      music.play(this.musicId);
      this.audioStarted = true;
    }

    if (this.paused) return; // ポーズ中は物理も進めない

    // カウントダウン進行
    let controlsEnabled = true;
    if (this.state === RaceState.Countdown) {
      controlsEnabled = false;
      this.countdown -= dt;
      // 3→2→1 の各カウントで「ピッ」（HUD の数字に同期）
      const n = Math.ceil(this.countdown);
      if (n !== this.lastCountN) {
        this.lastCountN = n;
        if (n >= 1 && n <= 3) this.engineSound.countBeep(n);
      }
      if (this.countdown <= 0) {
        this.state = RaceState.Racing;
        this.centerMsgTimer = RACE.GO_DISPLAY_SEC;
        this.engineSound.startBeep(); // スタートの合図
      }
    }

    // レースの時計：走行中は進める。プレイヤーのゴール後もリザルト表示までは
    // 進め続け（ライバルのゴールタイム計測のため）、HUD表示だけは固定する。
    if (
      this.state === RaceState.Racing ||
      (this.state === RaceState.Finished && !this.resultShown)
    ) {
      this.raceTime += dt;
    }

    // 全車へ入力 → 駆動（プレイヤーはキー、ライバルは AI）。
    // プレイヤーはゴール後は操作を受け付けず、自動でブレーキを掛けて徐々に停止させる
    // （低速になったらブレーキを離す＝X のバック走行に入って後退しないように）。
    const playerInput: InputState = this.player.finished
      ? {
          accel: false,
          brake: this.player.car.getSpeedKmh() > 5,
          steerLeft: false,
          steerRight: false,
        }
      : this.input.getState();
    for (const e of this.entrants) {
      const input = this.entrantInput(e, playerInput, dt);
      const offRoad = !this.track.isOnRoad(e.car.getPosition());
      e.car.update(dt, input, controlsEnabled, offRoad);
      // 川の中の岩など：踏むと車体が跳ねる（接地中のみ）。コース任意機能。
      if (this.track.bumpAt) {
        const vy = this.track.bumpAt(e.car.getPosition());
        if (vy > 0) e.car.applyBump(vy);
      }
    }

    // 物理を1回だけ進める（全車が同じワールドに居る）
    this.physics.step(dt);

    // 周回・順位
    if (this.state !== RaceState.Countdown) {
      for (const e of this.entrants) this.updateEntrantLap(e);
      this.updateStuckRecovery(dt);
    }
    this.updateStandings();

    // ゴール後、一定時間でリザルト画面を出す
    if (this.state === RaceState.Finished && !this.resultShown) {
      this.resultCountdown -= dt;
      if (this.resultCountdown <= 0) this.showResults();
    }

    // カメラ追従（プレイヤー）
    this.cameraCtrl.update(this.player.car.root, this.player.car.getDynamics(), dt);

    // エンジン音（プレイヤーの速度・アクセル感に追従）＋タイヤのスキッド音
    this.engineSound.update(this.player.car.getDynamics());
    this.engineSound.setSkid(this.player.car.getSkidIntensity());

    // HUD（プレイヤー基準）
    this.hud.setSpeed(this.player.car.getSpeedKmh());
    this.hud.setGear(this.player.car.getGearLabel());
    this.hud.setRpm(this.player.car.getRpm(), this.player.car.getRpmNorm());
    this.hud.setRaceTime(
      this.state === RaceState.Finished ? this.playerFinishTime : this.raceTime
    );
    this.hud.updateMinimap(
      this.player.car.getPosition(),
      this.entrants
        .filter((e) => e !== this.player)
        .map((e) => e.car.getPosition())
    );
    this.updateCenterMessage(dt);
  }

  /** その車のこのフレームの入力（プレイヤーはキー入力、ライバルは AI 出力） */
  private entrantInput(e: Entrant, playerInput: InputState, dt: number): InputState {
    if (!e.ai) return playerInput;
    return e.ai.update(
      e.car.getPosition(),
      e.car.getYaw(),
      e.car.getSpeedKmh() / 3.6,
      dt
    );
  }

  // ---- 周回・逆走 ----
  private updateEntrantLap(e: Entrant): void {
    if (e.finished) return; // ゴール済みは周回カウントを止める
    const pos = e.car.getPosition();
    const cps = this.track.checkpoints;
    const target = cps[e.nextCheckpointIdx];

    this.tmpFlat.set(pos.x, 0, pos.z);
    if (this.tmpFlat.distanceTo(target.position) < TRACK.CHECKPOINT_RADIUS) {
      const reached = e.nextCheckpointIdx;
      e.lastCheckpoint = cps[reached];
      e.nextCheckpointIdx = (reached + 1) % cps.length;

      // スタート/ゴールライン(index 0)を通過＝1周完了
      if (reached === 0) {
        e.lap++;
        if (e === this.player) this.recordPlayerLap();
        if (e.lap > TRACK.TOTAL_LAPS) {
          e.finished = true;
          e.finishOrder = ++this.finishCount;
          e.finishTime = this.raceTime;
          if (e === this.player) this.finishRace();
        } else if (e === this.player) {
          this.hud.setLap(Math.min(e.lap, TRACK.TOTAL_LAPS), TRACK.TOTAL_LAPS);
        }
      }
    }
  }

  /**
   * AI が壁際でコース外に停止し続けたら、最後のチェックポイントへ自動復帰させる。
   * （AI 自身のバック復帰でも抜けられない最悪ケースの保険。狭い急コーナーで詰まらない）
   */
  private updateStuckRecovery(dt: number): void {
    for (const e of this.entrants) {
      if (!e.ai || e.finished) continue;
      // 走行中に長く止まっていたら（壁刺さり/コース外/渋滞での詰まり問わず）復帰。
      // **その場で**中心線へスナップして停止＋進行方向を向かせる（後方へ戻さない）。
      // ＝助走で再加速して同じコーナーをまた失敗する無限ループを避ける。
      const stuck = e.car.getSpeedKmh() < 3;
      e.stuckTimer = stuck ? e.stuckTimer + dt : 0;
      if (e.stuckTimer > 2.5) {
        e.car.reset(this.snapToRoad(e.car.getPosition()), this.roadForwardAt(e.car.getPosition()));
        e.stuckTimer = 0;
      }
    }
  }

  /** pos を中心線上（最寄り点）へスナップした位置（y はスポーン高さ＝平坦物理） */
  private snapToRoad(pos: THREE.Vector3): THREE.Vector3 {
    const cl = this.track.centerline;
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < cl.length; i++) {
      const dx = cl[i].x - pos.x;
      const dz = cl[i].z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return new THREE.Vector3(cl[bi].x, this.track.getStartPosition().y, cl[bi].z);
  }

  /** pos 最寄りの中心線の進行方向 */
  private roadForwardAt(pos: THREE.Vector3): THREE.Vector3 {
    const cl = this.track.centerline;
    const n = cl.length;
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = cl[i].x - pos.x;
      const dz = cl[i].z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const a = cl[(bi - 1 + n) % n];
    const b = cl[(bi + 1) % n];
    const f = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    if (f.lengthSq() > 1e-6) f.normalize();
    return f;
  }

  /** プレイヤーが1周完了した瞬間のラップタイムを記録して HUD に出す */
  private recordPlayerLap(): void {
    this.lapSplits.push(this.raceTime - this.lastLapTime);
    this.lastLapTime = this.raceTime;
    this.hud.setLapTimes(this.lapSplits);
  }

  /** 各車の総走行距離を求めて順位（プレイヤーの位置）を HUD に出す */
  private updateStandings(): void {
    const half = this.trackLength * 0.5;
    for (const e of this.entrants) {
      const arc = this.arcAt(e.car.getPosition());
      // スタート線跨ぎ（弧長が大→小）で周回数+1、逆走で-1。連続した progress を作る。
      if (e.prevArc - arc > half) e.arcLaps++;
      else if (arc - e.prevArc > half) e.arcLaps--;
      e.prevArc = arc;
      e.progress = e.arcLaps * this.trackLength + arc;
    }
    const ranked = [...this.entrants].sort((a, b) => b.progress - a.progress);
    const pos = ranked.indexOf(this.player) + 1;
    this.hud.setPosition(pos, this.entrants.length);
  }

  /** pos に最も近い中心線サンプルの累積弧長 */
  private arcAt(pos: THREE.Vector3): number {
    const pts = this.track.centerline;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = pos.x - pts[i].x;
      const dz = pos.z - pts[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return this.cumLen[best];
  }

  private finishRace(): void {
    this.state = RaceState.Finished;
    this.playerFinishTime = this.raceTime; // 以後 HUD はこの値で固定表示
    this.resultCountdown = RACE.RESULT_DELAY_SEC;
    this.hud.setLap(TRACK.TOTAL_LAPS, TRACK.TOTAL_LAPS);
    this.centerMsgTimer = RACE.GOAL_DISPLAY_SEC;
    this.engineSound.finishJingle(); // ゴールの効果音
  }

  /** 最終順位・タイムを集計してリザルト画面を出す */
  private showResults(): void {
    this.resultShown = true;
    const ranked = [...this.entrants].sort((a, b) => {
      const af = a.finished ? a.finishOrder : Infinity;
      const bf = b.finished ? b.finishOrder : Infinity;
      if (af !== bf) return af - bf; // ゴール済みは着順
      return b.progress - a.progress; // 未ゴールは進行距離順
    });
    const rows = ranked.map((e, i) => ({
      pos: i + 1,
      name: e.spec.name,
      isPlayer: e === this.player,
      time: e.finished ? e.finishTime : null,
    }));

    // アーケード：プレイヤーの順位だけ見て「3位以内＝次へ／4位以下＝ゲームオーバー」
    let arcadeInfo:
      | {
          position: number;
          courseNumber: number;
          totalCourses: number;
          gameOver: boolean;
          isFinal: boolean;
        }
      | undefined;
    if (this.arcade) {
      const position = (rows.find((r) => r.isPlayer)?.pos ?? rows.length);
      const gameOver = position >= 4;
      const isFinal = this.arcade.courseIndex >= this.arcade.totalCourses - 1;
      this.arcadeOutcome = { position, gameOver, isFinal };
      arcadeInfo = {
        position,
        courseNumber: this.arcade.courseIndex + 1,
        totalCourses: this.arcade.totalCourses,
        gameOver,
        isFinal,
      };
    }

    this.hud.showResult(rows, this.playerFinishTime, this.lapSplits, arcadeInfo);
  }

  /** 逆走しているか（プレイヤー基準。最寄り中心線の進行方向と速度の内積で判定） */
  private isWrongWay(): boolean {
    const vel = this.player.car.getVelocity();
    vel.y = 0;
    if (vel.length() < RACE.WRONGWAY_MIN_SPEED) return false;

    // チェックポイントは数が少なく（疎）、ヘアピン等で折り返した区間では
    // 隣の“逆向き”CP が最寄りになって順走でも誤検出する。代わりに**連続な
    // 中心線の接線**（roadForwardAt）で判定する。中心線サンプルは密なので、
    // 折り返しの2本のライン（互いに十分離れている）も正しく取り違えない。
    const fwd = this.roadForwardAt(this.player.car.getPosition());
    const dot = vel.normalize().dot(fwd);
    return dot < RACE.WRONGWAY_DOT;
  }

  // ---- 中央メッセージ（カウントダウン / GO! / GOAL! / WRONG WAY） ----
  private updateCenterMessage(dt: number): void {
    if (this.state === RaceState.Countdown) {
      const n = Math.ceil(this.countdown);
      this.hud.showCenter(n > 0 ? String(n) : "GO!");
      return;
    }

    // GO! / FINISH の時限表示
    if (this.centerMsgTimer > 0) {
      this.centerMsgTimer -= dt;
      if (this.state === RaceState.Finished) {
        this.hud.showCenter(`FINISH  P${this.player.finishOrder}`);
      } else {
        this.hud.showCenter("GO!");
      }
      return;
    }

    // 走行中の逆走警告
    if (this.state === RaceState.Racing && this.isWrongWay()) {
      this.hud.showCenter("WRONG WAY");
      return;
    }

    this.hud.showCenter("");
  }

  // ---- ポーズ / リセット ----
  private togglePause(): void {
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
    if (!this.paused) this.clock.getDelta();
  }

}
