import type { CarDynamics } from "./Car";
import type { CarStyle } from "./CarRoster";

/**
 * 合成エンジン音（WebAudio）。外部音源は使わない。
 * 速度（回転数の代わり）でピッチを上げ、アクセル感に合わせて音量を膨らませる。
 *
 * 車ごとに音色（波形・ピッチ域・フィルタ・サブ低域・うなり）を変えて個性を出す
 * （{@link ENGINE_VOICES}）。Game がプレイヤーの車種を {@link setVoice} で渡す。
 *
 * カウントダウン/スタート/ゴールの効果音、タイヤのスキッド音も同じ AudioContext で鳴らす。
 *
 * ブラウザの自動再生制限のため、AudioContext は最初のユーザー操作後に
 * resume する必要がある（Game 側が start() を呼ぶ）。
 */

/** 1 つのオシレータの設定（複数重ねてエンジンの厚みを作る） */
interface OscSpec {
  type: OscillatorType;
  /** 基準周波数に対する倍率（1=そのまま, 0.5=1オクターブ下） */
  ratio: number;
  /** デチューン(セント) */
  detune: number;
  gain: number;
}

/** 車種ごとのエンジン音色 */
export interface EngineVoice {
  oscs: OscSpec[];
  /** アイドル時/最高速時の基準周波数(Hz)＝回転数の代わり */
  idleHz: number;
  topHz: number;
  /** ローパス cutoff：アイドル時 → 最高速時 */
  filterBase: number;
  filterTop: number;
  /** 全体音量 */
  master: number;
  /** うなり（osc[1] のデチューンを揺らす深さ・セント。0 で無効） */
  growlDepth: number;
  growlRate: number;
}

/**
 * 5 車種のエンジン音色。性能キャラに合わせて差をつける：
 * - lion   … バランス型の基準音
 * - hawk   … 高めで滑らか、伸びる高回転（最高速型）
 * - whale  … 低く図太いトルク型（サブ低域あり）
 * - piranha… 小排気量のビュンビュン高い軽い音
 * - wyvern … 重く獰猛なうなり（最高速の王・サブ低域＋うなり）
 */
export const ENGINE_VOICES: Record<CarStyle, EngineVoice> = {
  lion: {
    oscs: [
      { type: "sawtooth", ratio: 1, detune: 0, gain: 1 },
      { type: "square", ratio: 0.5, detune: -12, gain: 0.6 },
    ],
    idleHz: 70, topHz: 300, filterBase: 700, filterTop: 1500, master: 0.07,
    growlDepth: 0, growlRate: 0,
  },
  hawk: {
    oscs: [
      { type: "sawtooth", ratio: 1, detune: 6, gain: 0.9 },
      { type: "sawtooth", ratio: 1, detune: -6, gain: 0.9 },
      { type: "square", ratio: 2, detune: 0, gain: 0.18 }, // 高回転の伸びる倍音
    ],
    idleHz: 82, topHz: 372, filterBase: 950, filterTop: 2200, master: 0.064,
    growlDepth: 0, growlRate: 0,
  },
  whale: {
    oscs: [
      { type: "sawtooth", ratio: 1, detune: 0, gain: 1 },
      { type: "square", ratio: 0.5, detune: -10, gain: 0.7 },
      { type: "triangle", ratio: 0.25, detune: 0, gain: 0.7 }, // 図太いサブ低域
    ],
    idleHz: 56, topHz: 250, filterBase: 560, filterTop: 1150, master: 0.082,
    growlDepth: 5, growlRate: 4.5,
  },
  piranha: {
    oscs: [
      { type: "square", ratio: 1, detune: 0, gain: 0.85 },
      { type: "sawtooth", ratio: 1, detune: 14, gain: 0.7 },
    ],
    idleHz: 96, topHz: 388, filterBase: 1150, filterTop: 2400, master: 0.058,
    growlDepth: 0, growlRate: 0,
  },
  wyvern: {
    oscs: [
      { type: "sawtooth", ratio: 1, detune: -18, gain: 1 },
      { type: "sawtooth", ratio: 0.5, detune: 0, gain: 0.7 },
      { type: "sine", ratio: 0.25, detune: 0, gain: 0.8 }, // 重いサブ低域
    ],
    idleHz: 50, topHz: 330, filterBase: 540, filterTop: 1350, master: 0.086,
    growlDepth: 11, growlRate: 5.5,
  },
};

export class EngineSound {
  private ctx: AudioContext | null = null;
  /** エンジンのオシレータ群（voice.oscs に対応） */
  private oscs: OscillatorNode[] = [];
  private filter: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  // うなり用 LFO
  private growlOsc: OscillatorNode | null = null;
  // タイヤのスキッド音（ドリフト/スピン中の「キキー」）
  private skidNoise: AudioBufferSourceNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;
  private skidFilter2: BiquadFilterNode | null = null;
  private skidGain: GainNode | null = null;
  private started = false;
  private muted = false;

  /** プレイヤー車種の音色（start 前に setVoice で差し替え） */
  private voice: EngineVoice = ENGINE_VOICES.lion;

  /** スキッド音の最大音量 */
  private static readonly SKID_GAIN = 0.16;

  /** プレイヤーの車種に合わせてエンジン音色を設定する（start 前に呼ぶ）。 */
  setVoice(style: CarStyle): void {
    this.voice = ENGINE_VOICES[style] ?? ENGINE_VOICES.lion;
  }

  /**
   * ミュート状態を設定する。ミュート解除時に AudioContext がまだ無ければ
   * 呼び出し側（Game）が改めて start() を呼ぶこと。
   */
  setMuted(m: boolean): void {
    this.muted = m;
  }

  /**
   * 最初のユーザー操作後に呼ぶ。AudioContext を作って鳴らし始める。
   * ミュート中は何もしない（AudioContext を作るだけで iOS はバックグラウンド
   * 再生中の他アプリの音楽を止めてしまうため、解除まで一切作らない）。
   */
  start(): void {
    if (this.started || this.muted) return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const v = this.voice;

      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = v.filterBase;

      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.filter.connect(this.gain);
      this.gain.connect(this.ctx.destination);

      // うなり LFO（一部の車だけ）：osc[1] のデチューンを揺らす
      let growlGain: GainNode | null = null;
      if (v.growlDepth > 0) {
        this.growlOsc = this.ctx.createOscillator();
        this.growlOsc.frequency.value = v.growlRate;
        growlGain = this.ctx.createGain();
        growlGain.gain.value = v.growlDepth;
        this.growlOsc.connect(growlGain);
        this.growlOsc.start();
      }

      // エンジンのオシレータ群を voice から生成
      this.oscs = [];
      v.oscs.forEach((spec, i) => {
        const osc = this.ctx!.createOscillator();
        osc.type = spec.type;
        osc.detune.value = spec.detune;
        osc.frequency.value = v.idleHz * spec.ratio;
        const og = this.ctx!.createGain();
        og.gain.value = spec.gain;
        osc.connect(og);
        og.connect(this.filter!);
        if (growlGain && i === 1) growlGain.connect(osc.detune);
        osc.start();
        this.oscs.push(osc);
      });

      // --- タイヤのスキッド音：ホワイトノイズ → バンドパス2段 → ゲイン ---
      // 帯域を高めにして「キキー」とタイヤが甲高く滑る感じに。
      const sr = this.ctx.sampleRate;
      const noiseBuf = this.ctx.createBuffer(1, sr * 2, sr);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.skidNoise = this.ctx.createBufferSource();
      this.skidNoise.buffer = noiseBuf;
      this.skidNoise.loop = true;
      this.skidFilter = this.ctx.createBiquadFilter();
      this.skidFilter.type = "bandpass";
      this.skidFilter.frequency.value = 3400; // 「キー」の高め帯域
      this.skidFilter.Q.value = 9;
      this.skidFilter2 = this.ctx.createBiquadFilter();
      this.skidFilter2.type = "highpass"; // 低域を削ってより甲高く
      this.skidFilter2.frequency.value = 2400;
      this.skidGain = this.ctx.createGain();
      this.skidGain.gain.value = 0;
      this.skidNoise.connect(this.skidFilter);
      this.skidFilter.connect(this.skidFilter2);
      this.skidFilter2.connect(this.skidGain);
      this.skidGain.connect(this.ctx.destination);

      this.skidNoise.start();
      this.started = true;
      void this.ctx.resume();
    } catch {
      // 失敗しても無音で続行（音はあくまで演出）
      this.started = false;
    }
  }

  /** 一時停止後（リロード等）の最初のジェスチャで AudioContext を再開する。 */
  resume(): void {
    if (this.ctx) void this.ctx.resume();
  }

  /** 毎フレーム、速度・アクセル感に合わせて音を更新 */
  update(dyn: CarDynamics): void {
    if (!this.started || !this.ctx || !this.gain || !this.filter) return;
    const t = this.ctx.currentTime;
    const v = this.voice;
    // 速度で基準周波数（回転数）を上げる
    const freq = v.idleHz + (v.topHz - v.idleHz) * dyn.speedNorm;
    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i].frequency.setTargetAtTime(freq * v.oscs[i].ratio, t, 0.05);
    }
    // 速度でフィルタも開く（高回転ほど明るく）
    this.filter.frequency.setTargetAtTime(
      v.filterBase + (v.filterTop - v.filterBase) * dyn.speedNorm,
      t,
      0.08
    );

    // アクセル（加速中）と速度で音量を膨らませる
    const accelBoost = Math.max(0, dyn.accel) * 0.4;
    const target = this.muted
      ? 0
      : v.master * (0.4 + 0.6 * dyn.speedNorm + accelBoost);
    this.gain.gain.setTargetAtTime(target, t, 0.08);
  }

  /**
   * タイヤのスキッド音を滑り具合(0..1)で更新する。
   * ドリフト/スピン中だけ甲高く「キキー」と鳴り、滑りが深いほど大きく・高くなる。
   */
  setSkid(intensity: number): void {
    if (!this.started || !this.ctx || !this.skidGain || !this.skidFilter) return;
    const t = this.ctx.currentTime;
    const k = Math.max(0, Math.min(1, intensity));
    const target = this.muted ? 0 : EngineSound.SKID_GAIN * k;
    // 立ち上がりは速く、消えるのはやや緩く（キュッと鳴ってスッと引く）
    this.skidGain.gain.setTargetAtTime(target, t, k > 0.05 ? 0.02 : 0.08);
    // 帯域を高めに保ちつつ、深いほどさらに高く
    this.skidFilter.frequency.setTargetAtTime(3200 + 2600 * k, t, 0.05);
  }

  // ---- 効果音（カウントダウン/スタート/ゴール）-----------------------------

  /** エンベロープ付きの単音を鳴らす（効果音の部品） */
  private tone(
    freq: number,
    delay: number,
    dur: number,
    type: OscillatorType,
    peak: number,
    sweepTo?: number
  ): void {
    if (!this.ctx || this.muted) return;
    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, start + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  /** カウントダウンの「ピッ」（3→2→1 で少しずつ高く）。n=3..1 */
  countBeep(n: number): void {
    if (!this.started) return;
    const base = 540 + (3 - Math.max(1, Math.min(3, n))) * 90; // 1→720,2→630,3→540
    this.tone(base, 0, 0.16, "square", 0.16);
    this.tone(base * 2, 0, 0.12, "triangle", 0.06); // 倍音で締まりを足す
  }

  /** スタートの合図「ピィーッ」（高く長め＋オクターブ） */
  startBeep(): void {
    if (!this.started) return;
    this.tone(1046, 0, 0.5, "square", 0.2, 1320);
    this.tone(1568, 0, 0.45, "triangle", 0.09);
  }

  /** ゴールのファンファーレ（明るい上昇アルペジオ） */
  finishJingle(): void {
    if (!this.started) return;
    // C5 E5 G5 → C6 のきらびやかな上昇
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const d = i * 0.13;
      this.tone(f, d, i === notes.length - 1 ? 0.6 : 0.2, "square", 0.17);
      this.tone(f * 2, d, 0.18, "triangle", 0.05);
    });
  }

}
