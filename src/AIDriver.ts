import * as THREE from "three";
import { CarTuning } from "./CarTuning";
import type { InputState } from "./Input";

/** AI 1台分の個性 */
export interface AIOptions {
  /** 中心線からの横オフセット(m、+は進行方向左)。各車をずらして団子/重なりを避ける */
  laneOffset: number;
  /** 目標速度の倍率（MaxSpeed 基準。車の最高速倍率×腕前を掛けて渡す） */
  speedFactor: number;
  /** 路面グリップ倍率（<1=ダート）。コーナー速度の見積りを下げて膨らみを防ぐ */
  gripMul?: number;
  /** 車のステア倍率（<1=切れにくい）。切れにくい車はコーナーを控えめに */
  steerMul?: number;
  /**
   * AI の隠しグリップ倍率（Car.setAiBoost の grip と同じ値）。
   * コーナー目標速度をこの分だけ強気にする＝実際のグリップに見合った攻めにする。
   * 1（ブースト無し＝オーバル等）なら素のグリップ相当の控えめなコーナー速度になる。
   */
  cornerGrip?: number;
  /**
   * 操舵用の先読み距離の倍率（省略時1＝従来どおり）。
   * 曲がりくねったコースでは先読みが遠いと目標点がコーナーをショートカットして
   * 「大きくズレてる→ブレーキ」の振動に陥り、狭いS字を10m/s前後で這ってしまう。
   * <1 にすると近くのライン上の点を追う＝連続コーナーを流れるように曲がれる。
   */
  steerLeadMul?: number;
}

// 操舵の向き合わせ用。ゲームの steerLeft/Right の向きに合わせて符号を決める
// （検証の結果 -1。逆走/壁張り付きになるなら反転）。
const STEER_SIGN = -1;

/**
 * ライバル車を動かす単純なライン追従 AI。
 * 中心線の少し先（速度に応じた先読み点）を目標に操舵し、
 * 前方の曲率に応じて目標速度を下げてアクセル/ブレーキを切り替える。
 * プレイヤーと同じ Car に InputState を与えるだけなので、挙動・見た目は共通。
 */
export class AIDriver {
  private readonly pts: THREE.Vector3[];
  private readonly tangents: THREE.Vector3[];
  private readonly radius: number[]; // 各サンプルの曲率半径(m)
  private readonly n: number;
  private readonly spacing: number; // サンプル平均間隔(m)
  private readonly laneOffset: number;
  private readonly speedFactor: number;
  private readonly gripMul: number;
  private readonly steerMul: number;
  private readonly cornerGrip: number;
  private readonly steerLeadMul: number;

  /** スタック復帰用：低速が続いた時間(秒) と バック中の残り時間(秒) */
  private stuckTime = 0;
  private reverseTime = 0;

  constructor(centerline: THREE.Vector3[], opts: AIOptions) {
    this.pts = centerline;
    this.n = centerline.length;
    this.laneOffset = opts.laneOffset;
    this.speedFactor = opts.speedFactor;
    this.gripMul = opts.gripMul ?? 1;
    this.steerMul = opts.steerMul ?? 1;
    this.cornerGrip = opts.cornerGrip ?? 1;
    this.steerLeadMul = opts.steerLeadMul ?? 1;

    this.tangents = [];
    let total = 0;
    for (let i = 0; i < this.n; i++) {
      const prev = centerline[(i - 1 + this.n) % this.n];
      const next = centerline[(i + 1) % this.n];
      const t = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z);
      if (t.lengthSq() > 1e-6) t.normalize();
      this.tangents.push(t);
      total += centerline[i].distanceTo(centerline[(i + 1) % this.n]);
    }
    this.spacing = total / this.n;

    // 各サンプルの曲率半径（前後2サンプルの外接円）。コーナーの安全速度に使う。
    this.radius = [];
    for (let i = 0; i < this.n; i++) {
      const a = centerline[(i - 2 + this.n) % this.n];
      const b = centerline[i];
      const c = centerline[(i + 2) % this.n];
      const ab = Math.hypot(b.x - a.x, b.z - a.z);
      const bc = Math.hypot(c.x - b.x, c.z - b.z);
      const ca = Math.hypot(a.x - c.x, a.z - c.z);
      const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      this.radius.push(cross < 1e-6 ? Infinity : (ab * bc * ca) / (2 * cross));
    }
  }

  /** 進行方向に対する左（XZ平面、+90°） */
  private static leftOf(t: THREE.Vector3): { x: number; z: number } {
    return { x: t.z, z: -t.x };
  }

  /** pos に最も近い中心線サンプルの index */
  private nearestIndex(pos: THREE.Vector3): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.n; i++) {
      const dx = pos.x - this.pts[i].x;
      const dz = pos.z - this.pts[i].z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * @param pos   車の現在位置
   * @param yaw   車のヨー角(rad)。forward = (sin yaw, cos yaw)
   * @param speed 進行速度(m/s)
   * @param dt    フレーム時間(秒)。スタック判定に使う
   */
  update(
    pos: THREE.Vector3,
    yaw: number,
    speed: number,
    dt: number
  ): InputState {
    const i0 = this.nearestIndex(pos);

    // 速度に応じた先読み（速いほど遠くを見る）。停止時でも十分先を見て、
    // グリッドの横ズレに引っ張られて「真横が目標」になり発進できないのを防ぐ。
    const lookSamples = Math.max(
      2,
      Math.round(((12 + speed * 0.6) * this.steerLeadMul) / this.spacing)
    );
    const ti = (i0 + lookSamples) % this.n;
    const lt = AIDriver.leftOf(this.tangents[ti]);
    const tx = this.pts[ti].x + lt.x * this.laneOffset;
    const tz = this.pts[ti].z + lt.z * this.laneOffset;

    let dx = tx - pos.x;
    let dz = tz - pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;

    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const cross = fx * dz - fz * dx;
    const dot = fx * dx + fz * dz;
    const ang = Math.atan2(cross, dot) * STEER_SIGN; // 目標へ向くのに必要な符号付き角

    // --- スタック復帰：壁に刺さって低速が続いたら一旦バックして向き直す ---
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      // バック中は目標と逆へ切って車体を振り、抜けやすくする
      return { accel: false, brake: true, steerLeft: ang < 0, steerRight: ang > 0 };
    }
    if (speed < 2.5) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (this.stuckTime > 0.9) {
      this.stuckTime = 0;
      this.reverseTime = 0.9; // バックして壁から離れる
      return { accel: false, brake: true, steerLeft: ang < 0, steerRight: ang > 0 };
    }

    const dead = 0.04;
    const steerLeft = ang > dead;
    const steerRight = ang < -dead;

    // 目標速度＝前方区間の最小曲率半径から安全なコーナー速度を出す。
    // 見越し距離は速度に比例（速いほど早く減速）＋低グリップ路面では制動も弱いので
    // grip で割って手前から減速。長い吊り橋の先の急コーナーにも間に合うよう少し長め。
    const lead = (12 + speed * 1.7) / Math.max(this.gripMul, 0.5);
    const brakeWin = Math.max(2, Math.round(lead / this.spacing));
    let rmin = Infinity;
    for (let k = 0; k <= brakeWin; k++) {
      rmin = Math.min(rmin, this.radius[(i0 + k) % this.n]);
    }
    // 許容横G は半径に応じ可変（開けた高速コーナーは攻め／急コーナーは慎重）
    const latT = THREE.MathUtils.clamp((rmin - 18) / (45 - 18), 0, 1);
    // 素のグリップ相当の控えめな基準値（=ブースト無しのオーバル等で安全に曲がれる値）に、
    // AI の隠しグリップ倍率(cornerGrip)を掛ける＝ブーストした分だけコーナーを攻める。
    // cornerGrip=1 のコースでは素のグリップに見合った速度で曲がるので壁に膨らまない。
    // （ダート路面では gripMul で自動的に控えめになる。）
    const latAcc =
      THREE.MathUtils.lerp(8, 16, latT) *
      this.gripMul *
      this.cornerGrip *
      THREE.MathUtils.clamp(this.steerMul, 0.7, 1.05);
    const safeCorner = Math.sqrt(latAcc * rmin);
    const straightTarget = CarTuning.MaxSpeed * this.speedFactor;
    const targetSpeed = Math.min(straightTarget, safeCorner);

    // 基本は目標速度まで加速。停止/低速では多少ズレていても踏んで発進させる。
    // 減速は「出すぎ」か「ある程度の速度で大きくズレた」ときだけ。
    const misaligned = Math.abs(ang) > 0.55;
    const accel = speed < targetSpeed;
    const brake = speed > targetSpeed * 1.1 || (misaligned && speed > 10);

    return { accel, brake, steerLeft, steerRight };
  }
}
