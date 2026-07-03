/**
 * 出場車のラインナップ（プレイヤー選択 & ライバル用）。
 *
 * 全車は「いま実装されている車（＝レッドライオン）」をベースに、
 * 性能差は CarTuning に対する **倍率** で表現する（ほんの少しの差）。
 *   - accelMul   … 駆動力（EnginePower）の倍率＝加速
 *   - topSpeedMul… 最高速（MaxSpeed）の倍率
 *   - steerMul   … 最大舵角（MaxSteeringAngle）の倍率＝ステアの効き
 * 倍率なので、ユーザーが `window.CarTuning` を弄っても各車の相対差は保たれる。
 *
 * 見た目は AssetGenerator.createCarBody(style, colors) が style ごとに作り分ける。
 * いずれもデフォルメしたトイカー風のシルエット。
 */

/** 車種の見た目スタイル（AssetGenerator が分岐に使う） */
export type CarStyle = "lion" | "hawk" | "whale" | "piranha" | "wyvern";

export interface CarSpec {
  /** 識別子（= style） */
  id: CarStyle;
  /** 表示名（英） */
  name: string;
  /** 見た目スタイル */
  style: CarStyle;

  // ── 性能倍率（レッドライオン基準 = 1.0）──
  /** 加速（EnginePower 倍率） */
  accelMul: number;
  /** 最高速（MaxSpeed 倍率） */
  topSpeedMul: number;
  /** ステアの効き（MaxSteeringAngle 倍率） */
  steerMul: number;

  /**
   * 見た目だけのホイール表示倍率（物理は不変）。省略時は 1.0。
   * lion は参照画像どおり大径ブロックタイヤ＝フルサイズ(1.0=省略)。
   */
  wheelScale?: number;

  /** ホイール（ディッシュ/スポーク/ハブ）の色。省略時は明るいグレー。hawk=ブロンズ（TE37風）。 */
  rimColor?: number;

  // ── 見た目の色 ──
  /** ボディ色 */
  bodyColor: number;
  /** アクセント色（ストライプ／ウイング／ルーフ等） */
  accentColor: number;

  /** カード表示用の一言 */
  desc: string;
}

/**
 * 1台目〜5台目の順（この順で「スタートに近い側」から並ぶ。プレイヤーは最後尾）。
 */
export const CAR_ROSTER: CarSpec[] = [
  {
    id: "lion",
    name: "RED LION",
    style: "lion",
    accelMul: 1.0,
    topSpeedMul: 1.0,
    steerMul: 1.0,
    wheelScale: 0.9, // 参照画像どおりの大径ブロックタイヤ（見た目のみ。物理は不変）
    bodyColor: 0xd62828,
    accentColor: 0xf5f5f5,
    desc: "Balanced all-rounder. The benchmark car.",
  },
  {
    id: "hawk",
    name: "WHITE HAWK",
    style: "hawk",
    accelMul: 0.94,
    topSpeedMul: 1.06,
    steerMul: 1.0,
    wheelScale: 0.9, // 大径タイヤ（見た目のみ。物理は不変）
    rimColor: 0xa5793a, // ブロンズホイール（TE37風）
    bodyColor: 0xeef1f4,
    accentColor: 0x1c3f7a,
    desc: "Modest acceleration, but a high top speed.",
  },
  {
    id: "whale",
    name: "BLUE WHALE",
    style: "whale",
    accelMul: 1.08,
    topSpeedMul: 0.95,
    steerMul: 1.02,
    wheelScale: 0.9, // 大径タイヤ（見た目のみ。物理は不変）
    bodyColor: 0x1f6fd0,
    accentColor: 0xeaeef2,
    desc: "Lower top speed, but sharp acceleration.",
  },
  {
    id: "piranha",
    name: "YELLOW PIRANHA",
    style: "piranha",
    accelMul: 1.02,
    topSpeedMul: 0.93,
    steerMul: 1.2,
    wheelScale: 0.9, // 大径タイヤ（見た目のみ。物理は不変）
    bodyColor: 0xf2c12e,
    accentColor: 0xf5f5f5,
    desc: "Lower top speed, but very sharp steering.",
  },
  {
    id: "wyvern",
    name: "BLACK WYVERN",
    style: "wyvern",
    accelMul: 0.92,
    topSpeedMul: 1.12,
    steerMul: 0.82,
    wheelScale: 0.9, // 大径タイヤ（見た目のみ。物理は不変）
    bodyColor: 0x24262b,
    accentColor: 0xeef0f2, // 参照画像どおりの白ストライプ（旧・金）

    desc: "Sluggish steering and acceleration, but the top speed king.",
  },
];

/** id から spec を引く（無ければ先頭＝レッドライオン） */
export function getCarSpec(id: string): CarSpec {
  return CAR_ROSTER.find((c) => c.id === id) ?? CAR_ROSTER[0];
}
