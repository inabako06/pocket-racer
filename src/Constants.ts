/**
 * ゲーム全体のチューニング値を集約するモジュール。
 * マジックナンバーはここに置き、各クラスから参照する。
 * （バランス調整はこのファイルを編集するだけで完結させる方針）
 */

/** 描画・低解像度演出 */
export const RENDER = {
  /** 低解像度風に見せるための内部解像度スケール（1=等倍、0.5=半分） */
  RESOLUTION_SCALE: 0.5,
  /** フォグ密度（FogExp2）。大きいほど近くで霞む */
  FOG_DENSITY: 0.012,
  /** 背景・フォグ色（夕暮れ寄りの空色） */
  SKY_COLOR: 0x8fb6d6,
  /** 目標フレームレート */
  TARGET_FPS: 60,
} as const;

/** ライティング */
export const LIGHT = {
  AMBIENT_COLOR: 0x8899aa,
  AMBIENT_INTENSITY: 0.9,
  SUN_COLOR: 0xfff2cc,
  SUN_INTENSITY: 1.1,
  /** 太陽（平行光）の位置 */
  SUN_POSITION: { x: 40, y: 80, z: 30 },
} as const;

/**
 * カメラの構造的な値（FOV/距離/高さ/遅延などの「感触」は CarTuning.ts 側）。
 */
export const CAMERA = {
  NEAR: 0.1,
  FAR: 600,
  /** 俯瞰カメラ：より高く・後ろ */
  HIGH_OFFSET: { x: 0, y: 9, z: -13 },
  /** ボンネット視点：車内前方 */
  HOOD_OFFSET: { x: 0, y: 1.6, z: 1.2 },
  /** 注視点の高さ */
  LOOK_HEIGHT: 1.2,
} as const;

/**
 * 車の「構造」的な値（寸法・質量・サス長など）。
 * 加速/グリップ/ステア/カメラなどの "フィーリング" は CarTuning.ts に分離している。
 */
export const CAR = {
  /** 車体の質量(kg) */
  MASS: 180,
  /**
   * 車体ボックスの半径サイズ(half-extents) [x幅, y高さ, z長さ]。
   * 短くずんぐりさせ、相対的にタイヤを大きく見せる。
   */
  CHASSIS_HALF: { x: 0.82, y: 0.4, z: 1.25 },
  /** 車体ボディの地上からの初期高さ */
  SPAWN_HEIGHT: 1.3,

  /** タイヤ半径（特大） */
  WHEEL_RADIUS: 0.6,
  /** タイヤの太さ（極太） */
  WHEEL_WIDTH: 0.5,
  /** 前後タイヤのZ位置（車体中心から。四隅に寄せる） */
  WHEEL_Z: 0.95,
  /** 左右タイヤのX位置（車体側面から少し張り出す） */
  WHEEL_X: 0.9,
  /** タイヤ取り付け高さ（車体中心から下） */
  WHEEL_CONNECTION_Y: -0.2,

  /** サスペンション（硬さ・減衰は CarTuning 側、ここは寸法系） */
  SUSPENSION_REST_LENGTH: 0.4,
  SUSPENSION_MAX_FORCE: 100000,
  SUSPENSION_MAX_TRAVEL: 0.4,
  ROLL_INFLUENCE: 0.05,

  /** 芝（オフロード）走行時に掛ける軽いブレーキ（減速演出） */
  OFFROAD_BRAKE: 12,
  /** 芝（オフロード）走行時の駆動力倍率（遅くする。駆動輪はブレーキしないので発進は可能） */
  OFFROAD_POWER: 0.5,
} as const;

/** タイヤスモーク（ドリフト/スピン時の煙エフェクト） */
export const SMOKE = {
  /** これ以上の横滑り速度(m/s)で煙を出す */
  SLIP_THRESHOLD: 3.5,
  /** 煙を出す最低車速(m/s) */
  MIN_SPEED: 5,
  /** パーティクルの寿命(秒)。長めにしてもくもくと尾を引かせる */
  LIFETIME: 1.15,
  /** プール最大数（全4輪から大量に出すので多め） */
  MAX_PARTICLES: 400,
  /** 1フレーム・1輪あたりの発生数（大袈裟に増量） */
  PER_WHEEL_PER_FRAME: 5,
  /** 初期サイズ / 終了サイズ（大きく膨らませる） */
  START_SIZE: 0.55,
  END_SIZE: 3.4,
  /** 上昇速度(m/s) */
  RISE_SPEED: 1.7,
  /** 接地点から横へ広がる初速(m/s)。タイヤ脇から立ち上る感じ（広げすぎない） */
  SPREAD_SPEED: 1.0,
  /** 最大不透明度 */
  MAX_OPACITY: 0.72,
} as const;

/** 物理ワールド */
export const PHYSICS = {
  GRAVITY: -19.6, // 通常重力の2倍。アーケードらしくキビキビ接地させる
  /** 固定タイムステップ(秒) */
  FIXED_TIMESTEP: 1 / 60,
  /** 1フレームで処理する最大サブステップ数 */
  MAX_SUBSTEPS: 3,
} as const;

/** コース寸法（オーバル） */
export const TRACK = {
  /** 路面の幅（グリッドが収まるよう広め） */
  ROAD_WIDTH: 22,
  /** オーバルの直線部の長さ（片側）。スタートグリッドが直線内に収まる長さ */
  STRAIGHT_LENGTH: 90,
  /** オーバルのコーナー半径（中心線） */
  CORNER_RADIUS: 40,
  /** ガードレール高さ */
  RAIL_HEIGHT: 1.2,
  /** 周回数（ゴールまで） */
  TOTAL_LAPS: 2,
  /** チェックポイント数（スタート/ゴール含む論理分割） */
  CHECKPOINT_COUNT: 8,
  /** チェックポイント通過とみなす半径(m) */
  CHECKPOINT_RADIUS: 14,
  /** 芝（地面）のサイズ */
  GROUND_SIZE: 500,
} as const;

/** レース進行 */
export const RACE = {
  /** スタート前カウントダウン秒数（3,2,1） */
  COUNTDOWN_SEC: 3.2,
  /** "GO!" を表示し続ける秒数 */
  GO_DISPLAY_SEC: 1.2,
  /** "GOAL!" を表示する秒数（その後も走行は可能） */
  GOAL_DISPLAY_SEC: 4.0,
  /** ゴール後、リザルト画面を出すまでの待ち秒数 */
  RESULT_DELAY_SEC: 5.0,
  /** 逆走と判定する最低速度(m/s) */
  WRONGWAY_MIN_SPEED: 4,
  /** 逆走判定: 速度と進行方向の内積がこの値より小さければ逆走 */
  WRONGWAY_DOT: -0.3,
} as const;

/** 色（256色時代を意識したベタ塗り） */
export const COLOR = {
  ASPHALT: 0x4a4a52,
  ASPHALT_LINE: 0xe8e8e8,
  GRASS: 0x4f8f3f,
  RAIL: 0xd9d9d9,
  RAIL_POST: 0x888888,
  CAR_BODY: 0xd62828, // 鮮やかなレッド
  CAR_BODY_DARK: 0xa81d1d, // 下回り・陰
  CAR_STRIPE: 0xf5f5f5, // レーシングストライプ（白）
  CAR_WINDOW: 0x10141f, // 窓ガラス（濃紺）
  CAR_BUMPER: 0x2a2a2a, // バンパー（黒）
  CAR_GRILLE: 0x141414, // フロントグリル
  CAR_CHROME: 0xc8c8c8, // メッキ
  CAR_HEADLIGHT: 0xfff4c0, // ヘッドライト
  CAR_TAIL: 0xcc1717, // テールランプ
  CAR_SIGNAL: 0xff9a1f, // ウインカー（オレンジ）
  CAR_PLATE: 0xf2f2f2, // ナンバープレート地
  CAR_EXHAUST: 0xaaaaaa, // マフラー
  WHEEL: 0x1a1a1a,
  WHEEL_HUB: 0xc4c4c4,
  SHADOW: 0x000000,
  CHECKPOINT: 0xffd23f,
  SMOKE: 0xdadada,
  SMOKE_DIRT: 0x9c7a4d, // オフロード（ダート）のドリフト煙＝土色
} as const;
