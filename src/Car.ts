import * as THREE from "three";
import * as CANNON from "cannon-es";
import { CAR, SMOKE, COLOR } from "./Constants";
import { CarTuning } from "./CarTuning";
import { AssetGenerator } from "./AssetGenerator";
import { CAR_ROSTER, type CarSpec } from "./CarRoster";
import type { TrackSurface } from "./RaceTrack";
import { Physics } from "./Physics";

/** アスファルト相当の既定路面（係数すべて 1.0） */
const ASPHALT_SURFACE: TrackSurface = {
  gripMul: 1,
  driftSpeedMul: 1,
  driftEngageMul: 1,
};
import { TireSmoke } from "./TireSmoke";
import { Transmission } from "./Transmission";
import type { InputState } from "./Input";

// 前方は +Z。正のエンジン力は -Z へ働くので DRIVE_SIGN=-1 で「アクセル=前進(+Z)」。
// 後方カメラは +Z を見ており、その画面上の右は世界 -X 側。
// 「→ で画面の右(=-X)へ曲げる」には STEER_INPUT_SIGN=+1。（逆に感じたら反転）
const DRIVE_SIGN = -1;
const STEER_INPUT_SIGN = 1;

/** 前/後・左右のホイール添字 */
const WHEEL = {
  FRONT_LEFT: 0,
  FRONT_RIGHT: 1,
  REAR_LEFT: 2,
  REAR_RIGHT: 3,
} as const;
const FRONT_WHEELS = [WHEEL.FRONT_LEFT, WHEEL.FRONT_RIGHT];
const REAR_WHEELS = [WHEEL.REAR_LEFT, WHEEL.REAR_RIGHT];
const ALL_WHEELS = [0, 1, 2, 3];

/** ドリフト時に車体向きを設定するための Y 軸（使い回し） */
const DRIFT_UP = new CANNON.Vec3(0, 1, 0);

/** カメラ演出に渡す車の動的状態 */
export interface CarDynamics {
  /** 速度（0〜1に正規化、MaxSpeed基準） */
  speedNorm: number;
  /** 加減速の度合い（-1=強い減速〜+1=強い加速） */
  accel: number;
  /** ドリフトの横振れ（符号付き、カメラを外側へ振るのに使う） */
  driftSwing: number;
  /** カメラが向くべきヨー角(rad)。進行方向基準（ドリフト中は車体でなく進行方向を追う） */
  cameraYaw: number;
}

/**
 * デフォルメしたアーケードカー。
 * 物理は cannon-es の RaycastVehicle をベースに、CarTuning の値で
 * 「軽快・ドリフトしやすい・少しオーバー・常に少し滑る」フィーリングを作る。
 *
 * 前方は +Z。root は物理ボディと同じ姿勢でカメラ追従の基準。
 * 車体の揺れ（ロール/ピッチ/バウンド）は内側 tiltGroup にだけ掛ける。
 */
export class Car {
  /** カメラが追従する基準（傾きを含まない、ボディと同じ姿勢） */
  readonly root = new THREE.Group();

  private readonly body: CANNON.Body;
  private readonly vehicle: CANNON.RaycastVehicle;

  private readonly tiltGroup = new THREE.Group(); // 車体の揺れ用
  private readonly wheelSteerGroups: THREE.Group[] = [];
  private readonly wheelSpinGroups: THREE.Group[] = [];
  private readonly shadow: THREE.Mesh;
  private readonly smoke: TireSmoke;
  private readonly transmission = new Transmission();

  private currentSteer = 0;
  private wheelSpin = 0;
  private prevSpeed = 0;
  private drifting = false;
  private driftAngleCur = 0; // 現在のドリフト角(rad)
  private driftDir = 1; // ドリフトの向き（+1/-1、開始時の舵で決まる）
  private driftCharge = 0; // ドリフト突入までの「タメ」蓄積時間(秒)
  private cameraYaw = 0; // カメラが追う向き（進行方向基準、平滑化済み）
  private skidIntensity = 0; // タイヤの滑り具合(0..1)。スキッド音/煙に使う

  // AI 専用の隠しブースト（プレイヤーは全て1＝不変）。
  // 人間はドリフトでコーナーも最高速近くを維持できるが、AI は素直に減速するため遅い。
  // AI 車だけグリップ/舵角/速度をこっそり底上げし、コーナーを攻めて人間と同等に走らせる。
  // 見た目（車体）は変えないのであからさまなインチキにはならない。
  private aiAccelMul = 1;
  private aiTopMul = 1;
  private aiSteerMul = 1;
  private aiGripMul = 1;
  private aiYawMul = 1;

  // 演出用の状態
  private rollVis = 0;
  private pitchVis = 0;
  private bounceY = 0; // 着地バウンドの上下オフセット
  private bounceVel = 0;
  private wasAirborne = false;
  private dynamics: CarDynamics = {
    speedNorm: 0,
    accel: 0,
    driftSwing: 0,
    cameraYaw: 0,
  };

  // 使い回しの一時オブジェクト
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly forwardDir = new THREE.Vector3();
  private readonly rightDir = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly smokePos = new THREE.Vector3();

  /** この車の仕様（性能倍率・見た目・名前）。 */
  readonly spec: CarSpec;

  /** 現在の路面（ダート等で滑りやすさが変わる）。既定はアスファルト。 */
  private surface: TrackSurface = ASPHALT_SURFACE;

  /** 走行中の路面を設定（コースごとに Game が設定） */
  setSurface(surface: TrackSurface): void {
    this.surface = surface;
  }

  /**
   * 見た目の高さ関数（物理は平坦のまま、見た目だけ起伏に乗せる）。
   * Game がコースの elevationAt を設定する。既定は平坦（0）。
   */
  private elevationFn: ((x: number, z: number) => number) | null = null;
  setElevation(fn: (x: number, z: number) => number): void {
    this.elevationFn = fn;
  }
  /** 現在地点の見た目の高さ */
  private elevation(): number {
    return this.elevationFn
      ? this.elevationFn(this.body.position.x, this.body.position.z)
      : 0;
  }

  /** 加速：駆動力（基準 × 倍率 × AIブースト）。ユーザーが CarTuning を弄っても相対差は保つ。 */
  private get accelPower(): number {
    return CarTuning.EnginePower * this.spec.accelMul * this.aiAccelMul;
  }
  /** 最高速（基準 × 倍率 × AIブースト） */
  private get maxSpeed(): number {
    return CarTuning.MaxSpeed * this.spec.topSpeedMul * this.aiTopMul;
  }
  /** 最大舵角（基準 × 倍率 × AIブースト） */
  private get maxSteer(): number {
    return CarTuning.MaxSteeringAngle * this.spec.steerMul * this.aiSteerMul;
  }

  constructor(
    scene: THREE.Scene,
    physics: Physics,
    spec: CarSpec = CAR_ROSTER[0]
  ) {
    this.spec = spec;
    // --- シャシーボディ ---
    const half = CAR.CHASSIS_HALF;
    this.body = new CANNON.Body({
      mass: CAR.MASS,
      material: physics.chassisMaterial,
    });
    this.body.addShape(new CANNON.Box(new CANNON.Vec3(half.x, half.y, half.z)));
    this.body.position.set(0, CAR.SPAWN_HEIGHT, 0);
    this.body.angularDamping = 0.4;
    physics.addBody(this.body);

    // --- RaycastVehicle（前方=Z, 右=X, 上=Y） ---
    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.body,
      indexForwardAxis: 2,
      indexRightAxis: 0,
      indexUpAxis: 1,
    });

    const wheelOptions = {
      radius: CAR.WHEEL_RADIUS,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: CarTuning.SuspensionStrength,
      suspensionRestLength: CAR.SUSPENSION_REST_LENGTH,
      frictionSlip: CarTuning.RearGrip,
      dampingRelaxation: CarTuning.SuspensionDamping,
      dampingCompression: CarTuning.SuspensionDamping * 1.6,
      maxSuspensionForce: CAR.SUSPENSION_MAX_FORCE,
      rollInfluence: CAR.ROLL_INFLUENCE,
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
      maxSuspensionTravel: CAR.SUSPENSION_MAX_TRAVEL,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    };

    const cx = CAR.WHEEL_X;
    const cz = CAR.WHEEL_Z;
    const cy = CAR.WHEEL_CONNECTION_Y;
    const positions = [
      new CANNON.Vec3(-cx, cy, cz), // FL
      new CANNON.Vec3(cx, cy, cz), // FR
      new CANNON.Vec3(-cx, cy, -cz), // RL
      new CANNON.Vec3(cx, cy, -cz), // RR
    ];
    for (const p of positions) {
      wheelOptions.chassisConnectionPointLocal = p;
      this.vehicle.addWheel(wheelOptions);
    }
    // 前輪は後輪より高グリップ（フロントは食う／リアは少し流れる＝オーバー寄り）
    this.vehicle.wheelInfos[WHEEL.FRONT_LEFT].frictionSlip = CarTuning.FrontGrip;
    this.vehicle.wheelInfos[WHEEL.FRONT_RIGHT].frictionSlip = CarTuning.FrontGrip;
    this.vehicle.addToWorld(physics.world);

    // --- 見た目 ---
    this.tiltGroup.add(AssetGenerator.createCarBody(this.spec));
    this.root.add(this.tiltGroup);

    // 見た目だけのホイール表示倍率（物理半径は不変）。接地(底)を保つよう下げてスケール。
    const wheelScale = this.spec.wheelScale ?? 1;
    for (let i = 0; i < ALL_WHEELS.length; i++) {
      const steer = new THREE.Group();
      const spin = AssetGenerator.createWheel(this.spec.rimColor);
      if (wheelScale !== 1) {
        spin.scale.setScalar(wheelScale);
        // 縮小分だけ下げると、見た目の接地点が物理接地点(=半径 R の底)と一致する
        spin.position.y = -CAR.WHEEL_RADIUS * (1 - wheelScale);
      }
      steer.add(spin);
      steer.position.set(positions[i].x, positions[i].y, positions[i].z);
      this.root.add(steer);
      this.wheelSteerGroups.push(steer);
      this.wheelSpinGroups.push(spin);
    }

    scene.add(this.root);
    this.shadow = AssetGenerator.createBlobShadow();
    scene.add(this.shadow);
    this.smoke = new TireSmoke(scene);
  }

  // ── 公開ゲッター ─────────────────────────────────
  /** 符号付き前進速度(m/s)。前進が正、後退が負 */
  getForwardSpeed(): number {
    this.tmpQuat.set(
      this.body.quaternion.x,
      this.body.quaternion.y,
      this.body.quaternion.z,
      this.body.quaternion.w
    );
    this.forwardDir.set(0, 0, 1).applyQuaternion(this.tmpQuat);
    this.velocity.set(
      this.body.velocity.x,
      this.body.velocity.y,
      this.body.velocity.z
    );
    return this.velocity.dot(this.forwardDir);
  }

  /** 実際の進行速度(km/h)。ドリフトで車体が横を向いても進む速さを正しく表す */
  getSpeedKmh(): number {
    return Math.hypot(this.body.velocity.x, this.body.velocity.z) * 3.6;
  }

  /** ギア表示ラベル（バック中は "R"、それ以外は段数） */
  getGearLabel(): string {
    if (this.getForwardSpeed() < -0.8) return "R";
    return String(this.transmission.gear);
  }

  /** 現在のエンジン回転数(rpm) */
  getRpm(): number {
    return this.transmission.rpm;
  }

  /** タコメータ用の正規化回転数(0〜1) */
  getRpmNorm(): number {
    return this.transmission.getRpmNorm();
  }

  getPosition(): THREE.Vector3 {
    return new THREE.Vector3(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z
    );
  }

  getVelocity(): THREE.Vector3 {
    return new THREE.Vector3(
      this.body.velocity.x,
      this.body.velocity.y,
      this.body.velocity.z
    );
  }

  /** 車体のヨー角(rad)。forward=(sin yaw, cos yaw)。AI の操舵判定などに使う。 */
  getYaw(): number {
    const q = this.body.quaternion;
    return Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      1 - 2 * (q.y * q.y + q.z * q.z)
    );
  }

  /** カメラ演出用の動的状態（毎フレーム更新済み） */
  getDynamics(): CarDynamics {
    return this.dynamics;
  }

  isDrifting(): boolean {
    return this.drifting;
  }

  /**
   * AI 車だけの隠しブースト（グリップ/舵角/最高速/加速）。プレイヤーには使わない。
   * コーナーでの減速ぶんを底上げし、ドリフトで攻める人間に追従させる。
   */
  setAiBoost(b: {
    grip?: number;
    steer?: number;
    top?: number;
    accel?: number;
    yaw?: number;
  }): void {
    this.aiGripMul = b.grip ?? 1;
    this.aiSteerMul = b.steer ?? 1;
    this.aiTopMul = b.top ?? 1;
    this.aiAccelMul = b.accel ?? 1;
    // applyStability のヨーレート上限（スピン防止）の倍率。素の上限だと
    // 急コーナーは ~16m/s で頭打ち＝目標速度だけ上げても曲がれず壁に膨らむ。
    // タイトコーナーが続くコースではこれも一緒に上げて「実際に曲がれる」ようにする。
    this.aiYawMul = b.yaw ?? 1;
  }

  /**
   * 岩などに乗り上げて車体を上へ弾ませる（接地中だけ）。
   * 連続して踏むと着地→再ジャンプで「ポンポン」と跳ね、
   * 跳ねている間は車輪が接地せずグリップを失う＝カーブしにくくなる。
   * keepUpright は pitch/roll の角速度しか消さないので上方向の速度は残る。
   */
  applyBump(vy: number): void {
    if (this.groundedWheels() > 0 && this.body.velocity.y < 1.5) {
      this.body.velocity.y = vy;
      // 軽い乱れを与えて挙動を不安定に（カーブしにくさの演出）
      this.body.angularVelocity.y += (Math.random() - 0.5) * 2.0;
    }
  }

  /**
   * 入力に応じて駆動・操舵・制動・各種アシストを適用する。
   * @param controlsEnabled false の間は駆動/操舵を止めて惰性走行（カウントダウン中など）
   */
  update(
    dt: number,
    input: InputState,
    controlsEnabled: boolean,
    offRoad = false
  ): void {
    const speed = this.getForwardSpeed(); // 符号付き前進成分（バック判定用）
    // 実際の進行速度（横向きでも正しい）。FOV/ステア/ドリフト判定はこちら基準。
    const totalSpeed = Math.hypot(this.body.velocity.x, this.body.velocity.z);

    // オートマのギア・回転数を更新（表示用、物理には影響しない）
    this.transmission.update(totalSpeed);

    // 空中判定：4輪とも接地していない＝ジャンプ中。空中ではタイヤが路面を掴めないので
    // ステアは効かない（＝進入角はジャンプ前に決めておく）。着地時にいきなり曲がるのも防ぐ。
    const airborne = this.groundedWheels() === 0;

    // --- アクセル（速度依存カーブ：発進強・中速一気・最高速で鈍化） ---
    let engineForce = 0;
    let brake = 0;
    const speedNorm = THREE.MathUtils.clamp(totalSpeed / this.maxSpeed, 0, 1);

    if (controlsEnabled) {
      if (input.accel) {
        const curve = 1 - Math.pow(speedNorm, CarTuning.AccelCurveExp);
        engineForce = this.accelPower * Math.max(curve, 0);
      }
      // ブレーキ／バック
      if (input.brake) {
        if (speed > 1.0) {
          brake = CarTuning.BrakePower;
          engineForce = 0;
        } else {
          engineForce = -CarTuning.ReversePower;
        }
      }
    }

    // 路面外（芝/砂利）は駆動力を絞って遅くする（停止時に発進できなくなるのを防ぐため、
    // 駆動輪はブレーキせずパワーだけ落とす）。前進駆動のときのみ適用。
    if (offRoad && engineForce > 0) engineForce *= CAR.OFFROAD_POWER;

    // 駆動は後輪
    for (const w of REAR_WHEELS) {
      this.vehicle.applyEngineForce(DRIVE_SIGN * engineForce, w);
    }
    for (const w of FRONT_WHEELS) this.vehicle.applyEngineForce(0, w);

    // --- 操舵（低速大舵角・高速減・低遅延） ---
    const steerLimit =
      this.maxSteer *
      THREE.MathUtils.lerp(1, CarTuning.HighSpeedSteerFactor, speedNorm);
    let targetSteer = 0;
    if (controlsEnabled && !airborne) {
      if (input.steerLeft) targetSteer += steerLimit;
      if (input.steerRight) targetSteer -= steerLimit;
    }
    targetSteer *= STEER_INPUT_SIGN;
    this.currentSteer +=
      (targetSteer - this.currentSteer) * CarTuning.SteeringSpeed;
    this.vehicle.setSteeringValue(this.currentSteer, WHEEL.FRONT_LEFT);
    this.vehicle.setSteeringValue(this.currentSteer, WHEEL.FRONT_RIGHT);

    // --- ドリフト判定 ---
    // 突入条件（アクセル維持＋一定舵角＋一定速度）を満たしている間「タメ」を蓄積し、
    // 速度に応じた時間（低速ほど長い）切り続けて初めて滑り出す＝即ドリフトしない。
    // ドリフト突入の舵角しきい値は車ごとの最大舵角に合わせてスケールする。
    // （steerMul が小さい車＝最大舵角が小さい車でも、同じ“切り具合”でドリフトに入れる。
    //   絶対値で固定すると効きにくい車は高速で舵角がしきい値に届かず一生ドリフトできない）
    const steerEnough =
      Math.abs(this.currentSteer) >
      CarTuning.DriftSteerThreshold * this.spec.steerMul;
    const wantDrift =
      controlsEnabled &&
      input.accel &&
      steerEnough &&
      totalSpeed > CarTuning.DriftSpeedThreshold * this.surface.driftSpeedMul;
    const wasDrifting = this.drifting;

    if (!this.drifting) {
      if (wantDrift) {
        this.driftCharge += dt;
        const engageTime =
          THREE.MathUtils.lerp(
            CarTuning.DriftEngageTimeSlow,
            CarTuning.DriftEngageTimeFast,
            speedNorm
          ) * this.surface.driftEngageMul;
        if (this.driftCharge >= engageTime) this.drifting = true;
      } else {
        this.driftCharge = 0;
      }
    } else if (totalSpeed < CarTuning.DriftHoldSpeed * this.surface.driftSpeedMul) {
      // 失速で解除。アクセルを離したりステアを戻しても即解除はせず、
      // applyDriftControl 内でグリップが回復して角度が小さくなったら解除する。
      this.drifting = false;
      this.driftCharge = 0;
    }
    // 開始時：ドリフト方向を舵で決め、初期角を入れる（現在のスリップ以上）
    if (this.drifting && !wasDrifting) {
      this.driftCharge = 0;
      this.driftDir = Math.sign(this.currentSteer) || 1;
      // 開始角は「今の実スリップ角」から。ここから DriftBuildRate で徐々に深め、
      // カクッと一瞬で横を向かず、煙とともにじわっと滑り出す。
      const va = Math.atan2(this.body.velocity.x, this.body.velocity.z);
      const ch = Math.atan2(this.forwardDir.x, this.forwardDir.z);
      this.driftAngleCur = Math.abs(
        Math.atan2(Math.sin(ch - va), Math.cos(ch - va))
      );
    }

    // --- グリップ／制動／ドリフト ---
    if (this.drifting) {
      // ドリフト中：物理が打ち消さないよう全輪を低グリップ・駆動と制動はカットし、
      // 速度・進行方向・車体の向きを運動学的に制御してサステインドリフトを維持。
      this.setAllWheelGrip(CarTuning.DriftWheelGrip);
      for (const w of ALL_WHEELS) {
        this.vehicle.applyEngineForce(0, w);
        this.vehicle.setBrake(offRoad ? CAR.OFFROAD_BRAKE : 0, w);
      }
      this.applyDriftControl(
        dt,
        controlsEnabled && input.accel,
        controlsEnabled && input.brake,
        airborne
      );
    } else {
      // 通常：前輪>後輪グリップ。ブレーキ（＋芝）を適用し、横滑り減衰＋スピン抑制。
      this.setNormalGrip();
      this.driftAngleCur = 0;
      let frontBrake = brake;
      let rearBrake = brake;
      // 路面外の減速は「惰性（駆動していない）」ときだけブレーキで効かせる。
      // 駆動中（アクセル）にブレーキを掛けると停止時に発進できなくなるので、
      // 駆動中の減速は OFFROAD_POWER（駆動力ダウン）側だけで行う。
      if (offRoad && engineForce === 0) {
        frontBrake += CAR.OFFROAD_BRAKE;
        rearBrake += CAR.OFFROAD_BRAKE;
      }
      // 惰性（アクセルもブレーキも踏んでいない）時は弱いエンジンブレーキで少しだけ減速。
      // コーナー前にわずかに速度が落ちる程度＝上手なプレイヤーはドリフトで曲がる。
      const coasting = controlsEnabled && !input.accel && !input.brake;
      if (coasting && !offRoad) {
        frontBrake += CarTuning.CoastBrake;
        rearBrake += CarTuning.CoastBrake;
      }
      this.vehicle.setBrake(frontBrake, WHEEL.FRONT_LEFT);
      this.vehicle.setBrake(frontBrake, WHEEL.FRONT_RIGHT);
      this.vehicle.setBrake(rearBrake, WHEEL.REAR_LEFT);
      this.vehicle.setBrake(rearBrake, WHEEL.REAR_RIGHT);
      if (!airborne) this.applyStability(dt);
      // 急ブレーキ等で前後/左右に転覆しないよう、車体は常に水平（ヨーのみ）に保つ。
      // 前後の沈み・ロールは見た目の tiltGroup で表現しているため物理姿勢は水平でよい。
      // 空中ではヨーも固定して進入角を保つ（着地までハンドルで向きを変えられない）。
      this.keepUpright(airborne);
    }

    // --- 演出・煙 ---
    // ドリフト中はドリフト角の深さに応じて煙を増やす（突入時にじわっと立ち上がる）
    const driftIntensity = this.drifting
      ? this.driftAngleCur / ((CarTuning.DriftAngleMax * Math.PI) / 180)
      : 0;
    this.updateSmoke(dt, speed, driftIntensity, offRoad);
    this.syncVisuals(dt, speed, engineForce, brake, speedNorm);
  }

  /**
   * サステインドリフト（リッジレーサー風）の運動学制御。
   * - カメラは進行方向(travel)を追うので、画面に対しては「真っ直ぐ進む」。
   *   車体だけを進行方向よりドリフト角ぶん回転させる（斜め/横向き）。
   * - 曲がるのは「アクセルを踏んでいる間」だけ：進行方向がドリフト方向へ曲がる。
   * - アクセルを離すと曲がりは止まって直進し、速度を保ったままグリップが回復
   *   （ドリフト角がゆっくり戻り、立て直し切ると解除）。
   * 物理(step)の干渉は全輪低グリップで最小化してあるので、ここでの設定が支配的。
   */
  private applyDriftControl(
    dt: number,
    accel: boolean,
    braking: boolean,
    airborne = false
  ): void {
    const vx = this.body.velocity.x;
    const vz = this.body.velocity.z;
    let s = Math.hypot(vx, vz);
    if (s < CarTuning.DriftHoldSpeed * 0.5) return;

    const deg2rad = Math.PI / 180;
    const maxAngle = CarTuning.DriftAngleMax * deg2rad;

    const steerNorm = THREE.MathUtils.clamp(
      this.currentSteer / this.maxSteer,
      -1,
      1
    );
    const along = steerNorm * this.driftDir; // +1=ドリフト方向へ / -1=カウンター
    const building = accel && along > 0.15; // 角度を深めている最中か

    // ドリフト角の増減
    if (!accel) {
      // アクセルオフ：グリップ回復。曲がりは止まり、角度がゆっくり戻る
      this.driftAngleCur -= CarTuning.GripRecoverRate * deg2rad * dt;
    } else if (building) {
      // アクセル＋ドリフト方向へ切る：角度を深める
      this.driftAngleCur += CarTuning.DriftBuildRate * deg2rad * dt;
    } else if (along < -0.15) {
      // カウンター：素早く浅くする
      this.driftAngleCur -= CarTuning.DriftReleaseRate * deg2rad * dt;
    } else {
      // アクセル中で舵中立：ゆっくり浅くなる
      this.driftAngleCur -= CarTuning.DriftReleaseRate * 0.4 * deg2rad * dt;
    }
    this.driftAngleCur = THREE.MathUtils.clamp(this.driftAngleCur, 0, maxAngle);

    // 立て直し切ったらドリフト解除（物理に戻す）。
    // ただし立ち上げ中(building)は、開始直後の小さい角度で即解除しない。
    if (!building && this.driftAngleCur < CarTuning.DriftExitAngle * deg2rad) {
      this.drifting = false;
      return;
    }

    // 進行方向：アクセル中だけドリフト方向へ曲げる（深いほど鋭く）。離すと直進。
    // ただし空中ではタイヤが路面を掴めないので進行方向は変えられない（進入角を保つ）。
    let velAngle = Math.atan2(vx, vz);
    if (accel && !airborne) {
      const depth = this.driftAngleCur / maxAngle;
      velAngle += this.driftDir * CarTuning.DriftTurnRate * depth * dt;
    }

    // 速度はほぼ維持（わずかな減衰。ブレーキ時は強め）
    s *= 1 - CarTuning.DriftDrag * dt;
    if (braking) s *= 1 - CarTuning.DriftBrakeDrag * dt;
    this.body.velocity.x = Math.sin(velAngle) * s;
    this.body.velocity.z = Math.cos(velAngle) * s;

    // 車体は進行方向よりドリフト角ぶん内側を向く（斜め/横向き）
    const headingAngle = velAngle + this.driftAngleCur * this.driftDir;
    this.body.quaternion.setFromAxisAngle(DRIFT_UP, headingAngle);
    this.body.angularVelocity.set(0, 0, 0);
  }

  /**
   * 非ドリフト時の安定化：横滑りを少し抜き（常にわずかに滑る）、
   * グリップで実現できる旋回レートにヨーを頭打ち（スピン防止）。
   */
  private applyStability(dt: number): void {
    const sp = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    if (sp < CarTuning.AssistMinSpeed) return;

    this.rightDir.set(1, 0, 0).applyQuaternion(this.tmpQuat);
    const lateral =
      this.body.velocity.x * this.rightDir.x +
      this.body.velocity.z * this.rightDir.z;

    // ダートなど低グリップ路面では横滑りの抜けを弱め（＝よく滑る）
    const scrub = THREE.MathUtils.clamp(
      CarTuning.SideFriction * this.surface.gripMul * dt,
      0,
      1
    );
    this.body.velocity.x -= this.rightDir.x * lateral * scrub;
    this.body.velocity.z -= this.rightDir.z * lateral * scrub;

    const maxYaw =
      (CarTuning.SpinGripAccel * this.aiYawMul) /
        Math.max(sp, CarTuning.AssistMinSpeed) +
      CarTuning.SpinYawMargin;
    if (Math.abs(this.body.angularVelocity.y) > maxYaw) {
      this.body.angularVelocity.y =
        Math.sign(this.body.angularVelocity.y) * maxYaw;
    }
  }

  /**
   * 車体姿勢をヨーのみ（水平）に保ち、ピッチ／ロールでの転覆を防ぐ。
   * 平坦なコース前提のアーケード挙動。前後沈み・ロールの“見た目”は tiltGroup 側。
   */
  private keepUpright(airborne = false): void {
    const q = this.body.quaternion;
    const yaw = Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      1 - 2 * (q.y * q.y + q.z * q.z)
    );
    q.setFromAxisAngle(DRIFT_UP, yaw);
    this.body.angularVelocity.x = 0;
    this.body.angularVelocity.z = 0;
    // 空中はヨーの回転も止めて進入角を固定（ハンドルで向きを変えられない）。
    if (airborne) this.body.angularVelocity.y = 0;
  }

  /**
   * 後輪から煙を出す。煙の量はドリフトの深さ(driftIntensity 0..1)に比例させ、
   * ドリフト突入時はじわっと増えていく。非ドリフトのスピン時は横滑りで判定。
   */
  private updateSmoke(
    dt: number,
    speed: number,
    driftIntensity: number,
    offRoad = false
  ): void {
    let intensity = THREE.MathUtils.clamp(driftIntensity, 0, 1);
    if (intensity <= 0) {
      // 非ドリフトのスピン（横滑りが大きいとき）
      this.rightDir.set(1, 0, 0).applyQuaternion(this.tmpQuat);
      const lateral = Math.abs(
        this.body.velocity.x * this.rightDir.x +
          this.body.velocity.z * this.rightDir.z
      );
      if (Math.abs(speed) > SMOKE.MIN_SPEED && lateral > SMOKE.SLIP_THRESHOLD) {
        intensity = 1;
      }
    }
    this.skidIntensity = intensity;
    if (intensity > 0.08) {
      // オフロード（芝/砂利）またはダート路面では土煙の色にする
      const dirt = offRoad || this.surface.dirt === true;
      const color = dirt ? COLOR.SMOKE_DIRT : COLOR.SMOKE;
      const count = Math.max(1, Math.round(SMOKE.PER_WHEEL_PER_FRAME * intensity));
      // 全4輪のタイヤ位置から噴く（後輪多め・前輪少なめ）。
      // 自車視点でもタイヤ脇から立ち上って見えるよう、左右に出すのが効く。
      this.emitWheelSmoke(-CAR.WHEEL_X, -CAR.WHEEL_Z, count, color);
      this.emitWheelSmoke(CAR.WHEEL_X, -CAR.WHEEL_Z, count, color);
      const front = Math.max(1, Math.round(count * 0.7));
      this.emitWheelSmoke(-CAR.WHEEL_X, CAR.WHEEL_Z, front, color);
      this.emitWheelSmoke(CAR.WHEEL_X, CAR.WHEEL_Z, front, color);
    }
    this.smoke.update(dt);
  }

  /** タイヤの滑り具合(0..1)。スキッド音/煙の強さに使う。 */
  getSkidIntensity(): number {
    return this.skidIntensity;
  }

  private emitWheelSmoke(
    localX: number,
    localZ: number,
    count: number,
    color: number = COLOR.SMOKE
  ): void {
    // タイヤの設置位置(ローカル)をワールドへ。x/z は車体回転を反映した実際のタイヤ位置。
    this.smokePos.set(localX, -0.3, localZ).applyQuaternion(this.tmpQuat);
    this.smokePos.add(
      new THREE.Vector3(
        this.body.position.x,
        this.body.position.y,
        this.body.position.z
      )
    );
    // 接地点ぴったりだと車体に隠れて見えないので、タイヤ高さ(≒半径ぶん)から噴く。
    const ey = this.elevation();
    const emitY = ey + CAR.WHEEL_RADIUS * 0.7;
    for (let i = 0; i < count; i++) {
      this.smoke.emit(this.smokePos.x, emitY, this.smokePos.z, color);
    }
  }

  /** 通常時のグリップ（前輪>後輪でややオーバー寄り）。路面係数とAIブーストを反映。 */
  private setNormalGrip(): void {
    const g = this.surface.gripMul * this.aiGripMul;
    this.vehicle.wheelInfos[WHEEL.FRONT_LEFT].frictionSlip = CarTuning.FrontGrip * g;
    this.vehicle.wheelInfos[WHEEL.FRONT_RIGHT].frictionSlip = CarTuning.FrontGrip * g;
    this.vehicle.wheelInfos[WHEEL.REAR_LEFT].frictionSlip = CarTuning.RearGrip * g;
    this.vehicle.wheelInfos[WHEEL.REAR_RIGHT].frictionSlip = CarTuning.RearGrip * g;
  }

  /** 全輪を同じグリップに（ドリフト中の物理干渉を抑える用） */
  private setAllWheelGrip(slip: number): void {
    for (const info of this.vehicle.wheelInfos) info.frictionSlip = slip;
  }

  /** 接地している車輪数 */
  private groundedWheels(): number {
    let n = 0;
    for (const info of this.vehicle.wheelInfos) if (info.isInContact) n++;
    return n;
  }

  /**
   * 物理ボディ → 見た目へ反映し、車体の揺れ（ロール/ピッチ/バウンド）を作る。
   * 揺れは tiltGroup にだけ掛けるのでカメラ基準(root)には影響しない。
   */
  private syncVisuals(
    dt: number,
    speed: number,
    engineForce: number,
    brake: number,
    speedNorm: number
  ): void {
    // ルート姿勢＝ボディ姿勢（見た目だけ起伏ぶん y を持ち上げる）
    const ey = this.elevation();
    this.root.position.set(
      this.body.position.x,
      this.body.position.y + ey,
      this.body.position.z
    );
    this.root.quaternion.set(
      this.body.quaternion.x,
      this.body.quaternion.y,
      this.body.quaternion.z,
      this.body.quaternion.w
    );

    // ホイール：操舵＋転がり＋サス沈み込み
    this.wheelSpin += (speed / CAR.WHEEL_RADIUS) * dt;
    for (let i = 0; i < this.wheelSteerGroups.length; i++) {
      const info = this.vehicle.wheelInfos[i];
      const steerGroup = this.wheelSteerGroups[i];
      const susp = THREE.MathUtils.clamp(
        info.suspensionLength,
        0,
        CAR.SUSPENSION_REST_LENGTH + CAR.SUSPENSION_MAX_TRAVEL
      );
      steerGroup.position.y = CAR.WHEEL_CONNECTION_Y - susp;
      const isFront = i === WHEEL.FRONT_LEFT || i === WHEEL.FRONT_RIGHT;
      steerGroup.rotation.y = isFront ? this.currentSteer : 0;
      this.wheelSpinGroups[i].rotation.x = this.wheelSpin;
    }

    // --- ロール：旋回外側へ（操舵 × 速度） ---
    const rollTarget = -this.currentSteer * speedNorm * CarTuning.RollAmount * 4;
    this.rollVis += (rollTarget - this.rollVis) * CarTuning.BodyMotionLerp;

    // --- ピッチ：加速で後ろ沈み／ブレーキで前沈み ---
    const accel = (speed - this.prevSpeed) / Math.max(dt, 1e-3);
    this.prevSpeed = speed;
    // 入力ベースの目標（駆動中は後傾、ブレーキ中は前傾）。実加速度も少し混ぜる
    const driveBias =
      (engineForce > 0 ? 1 : 0) - (brake > 0 ? 1 : 0);
    const pitchTarget = THREE.MathUtils.clamp(
      driveBias * CarTuning.PitchAmount + -accel * 0.01,
      -CarTuning.PitchAmount,
      CarTuning.PitchAmount
    );
    this.pitchVis += (pitchTarget - this.pitchVis) * CarTuning.BodyMotionLerp;

    this.tiltGroup.rotation.z = this.rollVis;
    this.tiltGroup.rotation.x = this.pitchVis;

    // --- 着地バウンド：空中→接地の瞬間に上下を弾ませる ---
    const grounded = this.groundedWheels();
    if (this.wasAirborne && grounded >= 2) {
      this.bounceY = -CarTuning.BounceAmount; // いったん沈めてバネで戻す
    }
    this.wasAirborne = grounded === 0;
    // 減衰バネ（k=SuspensionStrength, c=SuspensionDamping を流用）
    this.bounceVel +=
      (-CarTuning.SuspensionStrength * this.bounceY -
        CarTuning.SuspensionDamping * this.bounceVel) *
      dt;
    this.bounceY += this.bounceVel * dt;
    this.tiltGroup.position.y = this.bounceY;

    // --- 影（ヨーのみ追従。起伏ぶん持ち上げる） ---
    this.shadow.position.set(this.body.position.x, ey + 0.04, this.body.position.z);
    const yaw = Math.atan2(
      2 *
        (this.body.quaternion.w * this.body.quaternion.y +
          this.body.quaternion.x * this.body.quaternion.z),
      1 -
        2 *
          (this.body.quaternion.y * this.body.quaternion.y +
            this.body.quaternion.z * this.body.quaternion.z)
    );
    this.shadow.rotation.z = -yaw;

    // --- カメラ演出用の動的状態を更新 ---
    this.dynamics.speedNorm = speedNorm;
    this.dynamics.accel = THREE.MathUtils.clamp(accel / 12, -1, 1);
    // ドリフト/横滑りの符号 × 速度（外側へカメラを振る）
    const lateral =
      this.body.velocity.x * this.rightDir.x +
      this.body.velocity.z * this.rightDir.z;
    this.dynamics.driftSwing = THREE.MathUtils.clamp(lateral / 8, -1, 1);

    // カメラの追従向き：通常は車体ヨー、ドリフト中は「進行方向」を追う。
    // → ドリフトで車体が横を向いても、カメラは進行方向の後方を保ち、
    //   車体だけがカメラに対して斜め/横に見える（リッジレーサー風）。
    const sp = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    let targetYaw = yaw; // 車体ヨー（上で算出済み）
    if (this.drifting && sp > 1) {
      targetYaw = Math.atan2(this.body.velocity.x, this.body.velocity.z);
    }
    const diff = Math.atan2(
      Math.sin(targetYaw - this.cameraYaw),
      Math.cos(targetYaw - this.cameraYaw)
    );
    this.cameraYaw += diff * CarTuning.CameraYawLerp;
    this.dynamics.cameraYaw = this.cameraYaw;
  }

  reset(pos: THREE.Vector3, forward: THREE.Vector3): void {
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.position.set(pos.x, pos.y, pos.z);

    const yaw = Math.atan2(forward.x, forward.z);
    const q = new CANNON.Quaternion();
    q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    this.body.quaternion.copy(q);

    this.currentSteer = 0;
    this.drifting = false;
    this.driftAngleCur = 0;
    this.driftCharge = 0;
    this.bounceY = 0;
    this.bounceVel = 0;
    this.rollVis = 0;
    this.pitchVis = 0;
    this.cameraYaw = yaw;
    this.dynamics.cameraYaw = yaw;
    this.transmission.reset();
    for (const w of ALL_WHEELS) {
      this.vehicle.setSteeringValue(0, w);
      this.vehicle.applyEngineForce(0, w);
      this.vehicle.setBrake(0, w);
    }
    this.body.wakeUp();
  }
}
