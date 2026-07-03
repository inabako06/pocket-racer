import type * as THREE from "three";
import type { Checkpoint } from "./Track";

/** 選択できるコースの識別子 */
export type TrackId =
  | "oval"
  | "beginner"
  | "tunnel"
  | "tunnelLong"
  | "highland"
  | "touge"
  | "forest"
  | "circuit"
  | "suzuka"
  | "shutoko";

/**
 * 路面の滑りやすさ（ダート等）。Car がグリップ/ドリフト挙動に掛ける係数。
 * 省略時はアスファルト相当（すべて 1.0）。
 */
export interface TrackSurface {
  /** タイヤグリップ倍率（<1 で滑りやすい＝ダート） */
  gripMul: number;
  /** ドリフト突入の速度しきい値の倍率（<1 で低速からドリフトに入る） */
  driftSpeedMul: number;
  /** ドリフト突入の「タメ」時間の倍率（<1 で素早くドリフトへ移行） */
  driftEngageMul: number;
  /** ダート路面か（true ならドリフト/スピンの煙を土色にする）。省略時 false＝舗装。 */
  dirt?: boolean;
}

/**
 * コースが満たすべき共通インターフェース。
 * Game はこのインターフェースだけに依存し、具体的なコース（Track / TrackBeginner）を
 * 差し替えられる。既存の Track（オーバル）は構造的にこれを満たす。
 */
export interface RaceTrack {
  /** チェックポイント（index 0 = スタート/ゴール） */
  readonly checkpoints: Checkpoint[];
  /**
   * 中心線サンプル点（y=0、順方向の閉ループ）。
   * AI のライン追従・順位計算（弧長）・スタートグリッド配置に使う。
   */
  readonly centerline: THREE.Vector3[];
  /** 路面の半幅(m)。スタートのレーン幅・AI のオフセット上限に使う。 */
  readonly roadHalfWidth: number;
  /** 路面の滑りやすさ（省略時アスファルト）。ダートコースで指定する。 */
  readonly surface?: TrackSurface;
  /**
   * 見た目上の路面の高さ（y）。物理は平坦なまま、ワールドと車を y にだけ持ち上げて
   * 起伏（上り/下り・吊り橋）を“見せる”ための関数。省略時は常に 0（平坦）。
   */
  elevationAt?(x: number, z: number): number;
  /**
   * その位置で岩などに乗り上げて跳ねる場合の「上向き初速(m/s)」。0 なら跳ねない。
   * elevationAt と違いこれは**挙動にも効く**（接地中だけ車を上へ弾ませる）。
   * 川の中の岩を踏むとポンポン跳ねてカーブしにくくする等に使う。省略時は常に 0。
   */
  bumpAt?(pos: THREE.Vector3): number;
  /** スタート位置（車の初期スポーン） */
  getStartPosition(): THREE.Vector3;
  /** スタート時の進行方向 */
  getStartForward(): THREE.Vector3;
  /** 路面上にいるか（芝判定） */
  isOnRoad(pos: THREE.Vector3): boolean;
}
