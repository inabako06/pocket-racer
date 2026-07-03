import {
  SONGS,
  type Song,
  type NoteEvent,
  type DrumHit,
  type Instrument,
} from "./MusicTracks";

/**
 * オリジナル BGM プレイヤー（WebAudio 合成）。外部音源ファイルは一切使わない
 * ＝ ゲーム全体の方針（プリミティブ/合成のみ）に合わせ、音楽もすべてシンセで合成する。
 *
 * 仕組み:
 * - 各曲は {@link MusicTracks.SONGS} に「ビート絶対時刻のノートイベント列」として定義。
 * - ルックアヘッド・スケジューラ（Chris Wilson 方式）で少し先のイベントを
 *   AudioContext の正確なタイムラインに予約し、曲尺ぶん進んだら先頭へ戻る＝シームレスループ。
 * - 楽器はプリセット（エレピ/ベル/パッド/ストリングス/ベース/リード/ブラス/プラック/
 *   マリンバ/フルート/ロックリード）。ドラムはキック/スネア/ハット/クラップ/タムを合成。
 *
 * ブラウザの自動再生制限のため AudioContext は最初のユーザー操作後に resume する。
 * EngineSound と同様、最初のキー/クリックで {@link resumeOnGesture} を呼ぶ。
 */

export type MusicTrackId =
  | "menu"
  | "oval"
  | "beginner"
  | "tunnel"
  | "highland"
  | "forest"
  | "touge"
  | "circuit"
  | "suzuka";

interface VoiceSpec {
  /** オシレータ波形（複数重ねて厚みを出す） */
  oscs: { type: OscillatorType; detune: number; gain: number }[];
  /** ローパスのベース cutoff(Hz) */
  cutoff: number;
  /** フィルタ・エンベロープでどれだけ cutoff を開くか（Hz, 0=固定） */
  filterEnv: number;
  /** ADSR（秒, sustain は 0..1） */
  a: number;
  d: number;
  s: number;
  r: number;
  /** ビブラート深さ(セント)・速さ(Hz)。0 で無効 */
  vibDepth: number;
  vibRate: number;
  /** 軽い歪み（ロック系）。0 で無効 */
  drive: number;
}

/** 楽器ごとの音作り */
const VOICES: Record<Instrument, VoiceSpec> = {
  // エレピ（Rhodes 風）：三角＋少しデチューン、丸いローパス
  epiano: { oscs: [{ type: "triangle", detune: 0, gain: 1 }, { type: "sine", detune: 6, gain: 0.5 }], cutoff: 2600, filterEnv: 1200, a: 0.005, d: 0.5, s: 0.25, r: 0.4, vibDepth: 0, vibRate: 0, drive: 0 },
  // シンセベル：正弦の倍音を重ねた金属的なきらめき
  bell: { oscs: [{ type: "sine", detune: 0, gain: 1 }, { type: "sine", detune: 1202, gain: 0.35 }, { type: "sine", detune: 1900, gain: 0.18 }], cutoff: 6000, filterEnv: 0, a: 0.002, d: 0.7, s: 0.0, r: 0.5, vibDepth: 0, vibRate: 0, drive: 0 },
  // シンセパッド：デチューンしたノコギリの群れ＋ゆっくり開くフィルタ
  pad: { oscs: [{ type: "sawtooth", detune: -8, gain: 0.6 }, { type: "sawtooth", detune: 8, gain: 0.6 }, { type: "sawtooth", detune: 0, gain: 0.4 }], cutoff: 1100, filterEnv: 900, a: 0.5, d: 0.8, s: 0.7, r: 0.9, vibDepth: 0, vibRate: 0, drive: 0 },
  // シンセストリングス：アンサンブル感のあるノコギリ群
  strings: { oscs: [{ type: "sawtooth", detune: -10, gain: 0.5 }, { type: "sawtooth", detune: 11, gain: 0.5 }, { type: "sawtooth", detune: 0, gain: 0.5 }], cutoff: 2200, filterEnv: 1400, a: 0.18, d: 0.5, s: 0.7, r: 0.5, vibDepth: 5, vibRate: 5.2, drive: 0 },
  // シンセベース：丸いノコギリ＋しっかりローパス
  bass: { oscs: [{ type: "sawtooth", detune: 0, gain: 1 }, { type: "square", detune: -12, gain: 0.5 }], cutoff: 900, filterEnv: 700, a: 0.004, d: 0.25, s: 0.55, r: 0.12, vibDepth: 0, vibRate: 0, drive: 0 },
  // サブベース：正弦で低域を支える
  subbass: { oscs: [{ type: "sine", detune: 0, gain: 1 }], cutoff: 500, filterEnv: 0, a: 0.006, d: 0.3, s: 0.8, r: 0.15, vibDepth: 0, vibRate: 0, drive: 0 },
  // リード：明るいノコギリ＋デチューンのうねり
  lead: { oscs: [{ type: "sawtooth", detune: -7, gain: 0.6 }, { type: "sawtooth", detune: 7, gain: 0.6 }], cutoff: 3200, filterEnv: 1600, a: 0.01, d: 0.2, s: 0.7, r: 0.18, vibDepth: 8, vibRate: 5.5, drive: 0 },
  // デジタルブラス：ノコギリ重ね＋エンベロープで開くフィルタ（ブラス特有のアタック）
  brass: { oscs: [{ type: "sawtooth", detune: -6, gain: 0.7 }, { type: "sawtooth", detune: 6, gain: 0.7 }, { type: "square", detune: 0, gain: 0.25 }], cutoff: 1200, filterEnv: 2600, a: 0.03, d: 0.18, s: 0.75, r: 0.2, vibDepth: 4, vibRate: 5, drive: 0 },
  // プラック（アルペジオ）：ノコギリの速い減衰
  pluck: { oscs: [{ type: "sawtooth", detune: 0, gain: 0.8 }, { type: "square", detune: 7, gain: 0.4 }], cutoff: 2600, filterEnv: 1800, a: 0.002, d: 0.28, s: 0.0, r: 0.18, vibDepth: 0, vibRate: 0, drive: 0 },
  // マリンバ：三角の速い減衰（木琴の柔らかいアタック）
  marimba: { oscs: [{ type: "triangle", detune: 0, gain: 1 }, { type: "sine", detune: 1200, gain: 0.3 }], cutoff: 3500, filterEnv: 0, a: 0.002, d: 0.32, s: 0.0, r: 0.2, vibDepth: 0, vibRate: 0, drive: 0 },
  // フルート：柔らかい正弦＋ビブラート（息っぽさ）
  flute: { oscs: [{ type: "sine", detune: 0, gain: 1 }, { type: "triangle", detune: 4, gain: 0.25 }], cutoff: 2400, filterEnv: 600, a: 0.05, d: 0.2, s: 0.85, r: 0.25, vibDepth: 11, vibRate: 5.8, drive: 0 },
  // ロックリード（エレキギター風シンセ）：ノコギリ＋軽い歪み
  rock: { oscs: [{ type: "sawtooth", detune: -5, gain: 0.7 }, { type: "sawtooth", detune: 6, gain: 0.7 }], cutoff: 2400, filterEnv: 1400, a: 0.008, d: 0.22, s: 0.65, r: 0.16, vibDepth: 9, vibRate: 6, drive: 14 },
};

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  /** ロック系の歪みカーブ（drive 量ごとにキャッシュ） */
  private shaperCache = new Map<number, Float32Array<ArrayBuffer>>();

  private current: MusicTrackId | null = null;
  private song: Song | null = null;
  private muted = false;

  // スケジューラ状態
  private timer: number | null = null;
  private loopStart = 0; // この周回が始まった ctx 時刻
  private idx = 0; // この周回でスケジュール済みの音符数
  private idxDrum = 0; // この周回でスケジュール済みのドラム数
  private beatDur = 0.5; // 1 ビートの秒数
  private loopLen = 0; // 1 周の秒数

  private static readonly LOOKAHEAD = 0.12; // 何秒先まで予約するか
  private static readonly TICK = 25; // スケジューラの間隔(ms)
  private static readonly MASTER_GAIN = 0.24; // 全体音量（エンジン音・効果音より控えめ）

  /** 最初のユーザー操作後に呼ぶ。AudioContext を作る（無ければ）。 */
  private ensureCtx(): boolean {
    if (this.ctx) return true;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.005;
      this.comp.release.value = 0.18;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MusicPlayer.MASTER_GAIN;
      this.comp.connect(this.master);
      this.master.connect(this.ctx.destination);

      // ノイズ（ドラム用）を一度だけ生成
      const sr = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, sr, sr);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  /** 指定の曲をループ再生する（既に同じ曲なら何もしない）。 */
  play(id: MusicTrackId): void {
    if (this.current === id && this.timer !== null) return;
    if (!this.ensureCtx() || !this.ctx) return;
    this.stopScheduler();
    this.current = id;
    this.song = SONGS[id];
    this.beatDur = 60 / this.song.bpm;
    this.loopLen = this.song.lengthBeats * this.beatDur;
    this.loopStart = this.ctx.currentTime + 0.1;
    this.idx = 0;
    this.idxDrum = 0;
    void this.ctx.resume();
    this.timer = window.setInterval(() => this.tick(), MusicPlayer.TICK);
    this.tick();
  }

  /** 一時停止後（リロード等）に最初のジェスチャで AudioContext を再開する。 */
  resumeOnGesture(): void {
    if (this.ctx) void this.ctx.resume();
  }

  stop(): void {
    this.stopScheduler();
    this.current = null;
    this.song = null;
  }

  private stopScheduler(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(
        m ? 0 : MusicPlayer.MASTER_GAIN,
        this.ctx.currentTime,
        0.05
      );
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // ---- スケジューラ本体 ----
  private tick(): void {
    if (!this.ctx || !this.song) return;
    const now = this.ctx.currentTime;
    const horizon = now + MusicPlayer.LOOKAHEAD;

    // 曲尺を跨いだら次の周回へ（シームレスループ）
    while (now >= this.loopStart + this.loopLen) {
      this.loopStart += this.loopLen;
      this.idx = 0;
      this.idxDrum = 0;
    }

    const notes = this.song.notes;
    while (this.idx < notes.length) {
      const ev = notes[this.idx];
      const when = this.loopStart + ev.t * this.beatDur;
      if (when >= horizon) break;
      if (when >= now - 0.05) this.playNote(ev, when);
      this.idx++;
    }
    const drums = this.song.drums;
    while (this.idxDrum < drums.length) {
      const h = drums[this.idxDrum];
      const when = this.loopStart + h.t * this.beatDur;
      if (when >= horizon) break;
      if (when >= now - 0.05) this.playDrum(h, when);
      this.idxDrum++;
    }
    // 出し終えても周回末尾の余韻ぶん時間が残る場合があるが、
    // 次の tick で loopStart を進めるのでここでは何もしない。
  }

  // ---- 1 音を鳴らす ----
  private playNote(ev: NoteEvent, when: number): void {
    const ctx = this.ctx!;
    const spec = VOICES[ev.inst];
    const dur = ev.dur * this.beatDur;
    const vel = ev.vel ?? 1;

    // 出力ゲイン（ADSR）
    const amp = ctx.createGain();
    const peak = 0.22 * ev.gain * vel;
    const a = spec.a;
    const d = spec.d;
    const sLvl = peak * spec.s;
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.linearRampToValueAtTime(peak, when + a);
    amp.gain.setTargetAtTime(Math.max(sLvl, 0.0001), when + a, d * 0.4 + 0.01);
    // リリース：ノート長の終わりから減衰
    const relStart = when + Math.max(dur, a + 0.02);
    amp.gain.setTargetAtTime(0.0001, relStart, spec.r * 0.5 + 0.01);
    const stopAt = relStart + spec.r + 0.1;

    // フィルタ（ローパス＋エンベロープで開く）
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = spec.drive > 0 ? 2 : 0.7;
    if (spec.filterEnv > 0) {
      filter.frequency.setValueAtTime(spec.cutoff, when);
      filter.frequency.linearRampToValueAtTime(spec.cutoff + spec.filterEnv, when + a + 0.005);
      filter.frequency.setTargetAtTime(spec.cutoff + spec.filterEnv * 0.3, when + a, d * 0.5 + 0.02);
    } else {
      filter.frequency.value = spec.cutoff;
    }

    // 任意の歪み（ロック系）
    let chainIn: AudioNode = filter;
    if (spec.drive > 0) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.driveCurve(spec.drive);
      shaper.oversample = "2x";
      filter.connect(shaper);
      chainIn = shaper;
    }
    chainIn.connect(amp);
    amp.connect(this.comp!);

    // ビブラート LFO（任意）
    let lfo: OscillatorNode | null = null;
    let lfoGain: GainNode | null = null;
    if (spec.vibDepth > 0) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = spec.vibRate;
      lfoGain = ctx.createGain();
      lfoGain.gain.value = spec.vibDepth;
      lfo.connect(lfoGain);
      lfo.start(when);
      lfo.stop(stopAt);
    }

    // オシレータ（複数重ね）
    const oscs: OscillatorNode[] = [];
    for (const o of spec.oscs) {
      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.frequency.value = ev.freq;
      osc.detune.value = o.detune;
      if (lfoGain) lfoGain.connect(osc.detune);
      const og = ctx.createGain();
      og.gain.value = o.gain;
      osc.connect(og);
      og.connect(filter);
      osc.start(when);
      osc.stop(stopAt);
      oscs.push(osc);
    }
  }

  // ---- ドラム 1 発を合成して鳴らす ----
  private playDrum(h: DrumHit, when: number): void {
    const ctx = this.ctx!;
    const g = (h.gain ?? 1) * 0.5;
    switch (h.type) {
      case "kick": {
        // 正弦のピッチ落とし込み＋速い減衰
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(150, when);
        osc.frequency.exponentialRampToValueAtTime(48, when + 0.11);
        amp.gain.setValueAtTime(g * 1.1, when);
        amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.22);
        osc.connect(amp);
        amp.connect(this.comp!);
        osc.start(when);
        osc.stop(when + 0.26);
        break;
      }
      case "snare": {
        // ノイズ（バンドパス）＋胴鳴りのトーン
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuf;
        const nf = ctx.createBiquadFilter();
        nf.type = "bandpass";
        nf.frequency.value = 1900;
        nf.Q.value = 0.8;
        const na = ctx.createGain();
        na.gain.setValueAtTime(g * 0.9, when);
        na.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
        noise.connect(nf);
        nf.connect(na);
        na.connect(this.comp!);
        const tone = ctx.createOscillator();
        tone.type = "triangle";
        tone.frequency.setValueAtTime(220, when);
        tone.frequency.exponentialRampToValueAtTime(170, when + 0.1);
        const ta = ctx.createGain();
        ta.gain.setValueAtTime(g * 0.35, when);
        ta.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
        tone.connect(ta);
        ta.connect(this.comp!);
        noise.start(when);
        noise.stop(when + 0.2);
        tone.start(when);
        tone.stop(when + 0.14);
        break;
      }
      case "hat":
      case "openhat": {
        const open = h.type === "openhat";
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuf;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 7000;
        const ha = ctx.createGain();
        const dec = open ? 0.22 : 0.05;
        ha.gain.setValueAtTime(g * 0.5, when);
        ha.gain.exponentialRampToValueAtTime(0.0001, when + dec);
        noise.connect(hp);
        hp.connect(ha);
        ha.connect(this.comp!);
        noise.start(when);
        noise.stop(when + dec + 0.02);
        break;
      }
      case "clap": {
        // 連続した短いノイズで「パンッ」
        const hp = ctx.createBiquadFilter();
        hp.type = "bandpass";
        hp.frequency.value = 1500;
        hp.Q.value = 0.7;
        const ha = ctx.createGain();
        ha.connect(this.comp!);
        hp.connect(ha);
        for (let i = 0; i < 3; i++) {
          const t = when + i * 0.012;
          ha.gain.setValueAtTime(g * 0.5, t);
          ha.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        }
        const noise = ctx.createBufferSource();
        noise.buffer = this.noiseBuf;
        noise.connect(hp);
        noise.start(when);
        noise.stop(when + 0.12);
        break;
      }
      case "tom": {
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = "sine";
        const f = h.freq ?? 160;
        osc.frequency.setValueAtTime(f, when);
        osc.frequency.exponentialRampToValueAtTime(f * 0.6, when + 0.16);
        amp.gain.setValueAtTime(g * 0.8, when);
        amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
        osc.connect(amp);
        amp.connect(this.comp!);
        osc.start(when);
        osc.stop(when + 0.28);
        break;
      }
    }
  }

  /** 現在再生中の曲（重複再生の判定にも使う） */
  get playing(): MusicTrackId | null {
    return this.timer !== null ? this.current : null;
  }

  /** 歪みカーブ（tanh 風ソフトクリップ） */
  private driveCurve(amount: number): Float32Array<ArrayBuffer> {
    const cached = this.shaperCache.get(amount);
    if (cached) return cached;
    const n = 1024;
    const curve = new Float32Array(new ArrayBuffer(n * 4));
    const k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    this.shaperCache.set(amount, curve);
    return curve;
  }
}

/** アプリ全体で共有する BGM プレイヤー（メニューは main.ts、レースは Game.ts が使う）。 */
export const music = new MusicPlayer();

