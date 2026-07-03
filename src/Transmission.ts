import { CarTuning } from "./CarTuning";

/** 回転数の追従なめらかさ（針の動きの滑らかさ。0〜1） */
const RPM_SMOOTH = 0.2;

/**
 * オートマ・トランスミッションの表示用モデル。
 * 実際の物理（駆動力）には影響せず、車速からギア段と回転数を導いてHUDに見せる。
 * - 速度帯で自動変速（ヒステリシス付き）。
 * - 回転数は各ギア内の速度進捗を idle〜redline にマップ。シフトアップで下がる。
 */
export class Transmission {
  /** 現在のギア（1〜段数） */
  gear = 1;
  /** 現在の回転数(rpm) */
  rpm = CarTuning.IdleRpm;

  /** ギア g(1始まり)の上限速度(m/s) */
  private topSpeed(g: number): number {
    return CarTuning.GearSpeedFractions[g - 1] * CarTuning.MaxSpeed;
  }
  /** ギア g(1始まり)の下限速度(m/s) */
  private bottomSpeed(g: number): number {
    return g <= 1 ? 0 : CarTuning.GearSpeedFractions[g - 2] * CarTuning.MaxSpeed;
  }

  /** 速度(m/s, 進行速度の大きさ)からギアと回転数を更新 */
  update(speed: number): void {
    const gears = CarTuning.GearSpeedFractions.length;

    // 自動変速（1フレーム1段、ヒステリシス付き）
    if (this.gear < gears && speed > this.topSpeed(this.gear)) {
      this.gear++;
    } else if (
      this.gear > 1 &&
      speed < this.bottomSpeed(this.gear) * CarTuning.ShiftDownHysteresis
    ) {
      this.gear--;
    }

    // ギア内の速度進捗 → 回転数
    const bottom = this.bottomSpeed(this.gear);
    const top = this.topSpeed(this.gear);
    const progress = Math.max(0, Math.min(1.05, (speed - bottom) / Math.max(top - bottom, 0.001)));
    const targetRpm =
      CarTuning.IdleRpm + (CarTuning.RedlineRpm - CarTuning.IdleRpm) * progress;

    // 針が滑らかに動くよう補間
    this.rpm += (targetRpm - this.rpm) * RPM_SMOOTH;
    this.rpm = Math.max(CarTuning.IdleRpm, Math.min(CarTuning.MaxRpm, this.rpm));
  }

  /** タコメータ用の正規化回転数(0〜1) */
  getRpmNorm(): number {
    return Math.max(0, Math.min(1, this.rpm / CarTuning.MaxRpm));
  }

  /** リセット時など */
  reset(): void {
    this.gear = 1;
    this.rpm = CarTuning.IdleRpm;
  }
}
