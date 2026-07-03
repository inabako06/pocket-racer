/**
 * オリジナル BGM のデータと作曲ヘルパー（{@link MusicPlayer} が再生する）。
 *
 * 方針:
 * - メロディ/コード進行/フレーズはすべて自作（既存曲の流用なし）。
 * - 曲は「8 小節サイクル × 数回」を基本構造にし、サイクルごとに鳴らすレイヤー
 *   （パッド/アルペジオ/ベース/ドラム/メロディ）を切り替えて *明快な展開* を作る
 *   （イントロ→ビルドアップ→サビ→ブレイク→サビ復帰）。最後の V→I 等で頭へ自然にループ。
 * - 楽器はシンセ主体（PS時代風。FM ではなく素直な減算合成）。
 *
 * すべての音符は「ループ先頭からのビート絶対時刻」で持ち、{@link MusicPlayer} が
 * 曲尺ぶん進むごとに先頭へ戻す＝シームレスループ。
 */

export type Instrument =
  | "epiano"
  | "bell"
  | "pad"
  | "strings"
  | "bass"
  | "subbass"
  | "lead"
  | "brass"
  | "pluck"
  | "marimba"
  | "flute"
  | "rock";

export type DrumType = "kick" | "snare" | "hat" | "openhat" | "clap" | "tom";

export interface NoteEvent {
  /** ループ先頭からのビート */
  t: number;
  /** 長さ（ビート） */
  dur: number;
  /** 周波数(Hz)。作曲時に音名から算出済み */
  freq: number;
  inst: Instrument;
  /** トラック相対ゲイン */
  gain: number;
  vel?: number;
}

export interface DrumHit {
  t: number;
  type: DrumType;
  gain?: number;
  /** タム用の基音 */
  freq?: number;
}

export interface Song {
  bpm: number;
  /** 1 ループのビート数 */
  lengthBeats: number;
  /** t 昇順に整列済み */
  notes: NoteEvent[];
  drums: DrumHit[];
}

// ---- 音名 → 周波数 -------------------------------------------------------
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4" "F#3" "Bb5" → Hz（A4=440, C4=MIDI60） */
function nf(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error("bad note: " + name);
  let semi = SEMI[m[1]];
  if (m[2] === "#") semi += 1;
  else if (m[2] === "b") semi -= 1;
  const midi = (parseInt(m[3], 10) + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---- 作曲アキュムレータ -------------------------------------------------
type BassStyle = "drive" | "rockoct" | "half" | "quarter" | "pump";

interface GrooveDef {
  kick: string;
  snare: string;
  hat?: string;
  ohat?: string;
  clap?: string;
  gain?: number;
}

class Comp {
  notes: NoteEvent[] = [];
  drums: DrumHit[] = [];

  /** 単旋律/和音の列。トークン "C4:1" / 休符 "_:0.5" / 和音 "C4/E4/G4:2"。dur 省略=1 */
  seq(inst: Instrument, gain: number, start: number, str: string): number {
    let t = start;
    for (const tok of str.trim().split(/\s+/)) {
      if (!tok) continue;
      const ci = tok.lastIndexOf(":");
      const pitch = ci >= 0 ? tok.slice(0, ci) : tok;
      const dur = ci >= 0 ? parseFloat(tok.slice(ci + 1)) : 1;
      if (pitch !== "_") {
        for (const p of pitch.split("/")) {
          this.notes.push({ t, dur, freq: nf(p), inst, gain });
        }
      }
      t += dur;
    }
    return t;
  }

  /** コード列をパッド/ストリングスとして各小節 sustain */
  pad(inst: Instrument, gain: number, start: number, chords: string[], barBeats = 4): void {
    let t = start;
    for (const ch of chords) {
      for (const p of ch.split("/")) {
        this.notes.push({ t, dur: barBeats * 0.96, freq: nf(p), inst, gain });
      }
      t += barBeats;
    }
  }

  /** ベース：小節ごとのルート音名をスタイル別の刻みで */
  bass(inst: Instrument, gain: number, start: number, roots: string[], style: BassStyle): void {
    let t = start;
    for (const r of roots) {
      const f = nf(r);
      if (style === "drive") {
        for (let i = 0; i < 8; i++) this.notes.push({ t: t + i * 0.5, dur: 0.42, freq: f, inst, gain });
      } else if (style === "rockoct") {
        for (let i = 0; i < 8; i++) {
          const up = i % 4 === 2 || i % 4 === 3;
          this.notes.push({ t: t + i * 0.5, dur: 0.42, freq: up ? f * 2 : f, inst, gain });
        }
      } else if (style === "pump") {
        // ダウンビートを抜いた裏拍の弾み（ハウス/トランス風）
        for (let i = 0; i < 8; i++) if (i % 2 === 1) this.notes.push({ t: t + i * 0.5, dur: 0.4, freq: f, inst, gain: gain * 1.1 });
        this.notes.push({ t, dur: 0.3, freq: f, inst, gain });
      } else if (style === "quarter") {
        for (let i = 0; i < 4; i++) this.notes.push({ t: t + i, dur: 0.9, freq: f, inst, gain });
      } else {
        // half
        this.notes.push({ t, dur: 1.8, freq: f, inst, gain });
        this.notes.push({ t: t + 2, dur: 1.8, freq: f, inst, gain });
      }
      t += 4;
    }
  }

  /** アルペジオ：コードの構成音を 16 分で循環 */
  arp(inst: Instrument, gain: number, start: number, chords: string[], order: number[], step = 0.25): void {
    let t = start;
    for (const ch of chords) {
      const tones = ch.split("/").map(nf);
      const per = Math.round(4 / step);
      for (let i = 0; i < per; i++) {
        const f = tones[order[i % order.length] % tones.length];
        this.notes.push({ t: t + i * step, dur: step * 0.9, freq: f, inst, gain });
      }
      t += 4;
    }
  }

  /** ドラム・グルーブを bars 小節ぶん繰り返す（16 ステップ文字列） */
  groove(start: number, bars: number, g: GrooveDef): void {
    const gg = g.gain ?? 1;
    const lay = (pat: string | undefined, type: DrumType, gain: number) => {
      if (!pat) return;
      const steps = pat.length;
      const step = 4 / steps;
      for (let b = 0; b < bars; b++) {
        for (let i = 0; i < steps; i++) {
          const c = pat[i];
          if (c === "." || c === " ") continue;
          this.drums.push({ t: start + b * 4 + i * step, type, gain: gain * gg * (c === "X" ? 1.3 : 1) });
        }
      }
    };
    lay(g.kick, "kick", 1);
    lay(g.snare, "snare", 0.95);
    lay(g.hat, "hat", 0.8);
    lay(g.ohat, "openhat", 0.7);
    lay(g.clap, "clap", 0.85);
  }
}

// ---- サイクル構造（明快な展開）を一括レンダリングする汎用ビルダー ----------
interface CycleLayers {
  pad?: boolean;
  arp?: boolean;
  bass?: boolean;
  drums?: boolean;
  /** 鳴らすメロディ（"A"/"B"/なし） */
  mel?: "A" | "B" | null;
  /** ハーモニー/カウンターメロディ */
  harm?: boolean;
}

interface SongDef {
  bpm: number;
  barsPerCycle: number;
  /** 各小節のコード・ボイシング（length=barsPerCycle） */
  chords: string[];
  /** 各小節のベース・ルート */
  roots: string[];
  bassStyle: BassStyle;
  bassInst: Instrument;
  padInst: Instrument;
  arpInst?: Instrument;
  arpOrder?: number[];
  arpStep?: number;
  melInst: Instrument;
  melGain?: number;
  /** 1 サイクル分のメロディ（barsPerCycle*4 ビート） */
  melodyA: string;
  melodyB?: string;
  harmInst?: Instrument;
  harmony?: string;
  groove: GrooveDef;
  /** イントロ専用の薄いグルーブ（任意） */
  grooveSoft?: GrooveDef;
  /** サイクルごとのレイヤー（length=ループのサイクル数） */
  layers: CycleLayers[];
}

function render(def: SongDef): Song {
  const c = new Comp();
  const bpc = def.barsPerCycle;
  const cycleBeats = bpc * 4;
  def.layers.forEach((L, ci) => {
    const start = ci * cycleBeats;
    if (L.pad) c.pad(def.padInst, 0.5, start, def.chords);
    if (L.arp && def.arpInst) {
      c.arp(def.arpInst, 0.34, start, def.chords, def.arpOrder ?? [0, 1, 2, 1], def.arpStep ?? 0.25);
    }
    if (L.bass) c.bass(def.bassInst, 0.95, start, def.roots, def.bassStyle);
    if (L.drums) c.groove(start, bpc, def.groove);
    else if (def.grooveSoft && (L.pad || L.arp)) c.groove(start, bpc, def.grooveSoft);
    if (L.mel === "A") c.seq(def.melInst, def.melGain ?? 0.85, start, def.melodyA);
    else if (L.mel === "B" && def.melodyB) c.seq(def.melInst, def.melGain ?? 0.85, start, def.melodyB);
    if (L.harm && def.harmInst && def.harmony) c.seq(def.harmInst, 0.5, start, def.harmony);
  });
  c.notes.sort((a, b) => a.t - b.t);
  c.drums.sort((a, b) => a.t - b.t);
  return { bpm: def.bpm, lengthBeats: def.layers.length * cycleBeats, notes: c.notes, drums: c.drums };
}

// =========================================================================
//  曲 1 — メニュー "SUNNY GARAGE"  C major / 115 BPM / ポップで期待感
//  休日の朝、これからレースが始まるワクワク感。エレピ＋ベル＋パッド。
// =========================================================================
const MENU: SongDef = {
  bpm: 115,
  barsPerCycle: 8,
  // I  V/B  vi7  iii  IV  I/E  ii7  V  （温かいポップ進行）
  chords: [
    "C4/E4/G4", "B3/D4/G4", "A3/C4/E4/G4", "E3/G3/B3",
    "F3/A3/C4", "E3/G3/C4", "D3/F3/A3/C4", "D3/G3/B3",
  ],
  roots: ["C2", "G2", "A2", "E2", "F2", "C2", "D2", "G2"],
  bassStyle: "half",
  bassInst: "bass",
  padInst: "pad",
  arpInst: "bell",
  arpOrder: [0, 1, 2, 3, 2, 1],
  melInst: "epiano",
  melodyA: [
    "E4:1 G4:1 C5:1.5 _:0.5",   // C
    "B4:1 A4:1 G4:2",            // G/B
    "A4:1 C5:1 E5:1.5 D5:0.5",   // Am7
    "B4:2 G4:2",                 // Em
    "A4:1 C5:1 F5:1.5 E5:0.5",   // F
    "G4:1 E4:1 G4:2",            // C/E
    "F4:1 A4:1 D5:1 C5:1",       // Dm7
    "D5:1.5 B4:0.5 G4:2",        // G → 頭の C へ
  ].join(" "),
  melodyB: [
    "G4:1 C5:1 E5:1 G5:1",       // C  サビ上げ
    "F5:1.5 D5:0.5 G4:2",        // G/B
    "E5:1 D5:1 C5:1 E5:1",       // Am7
    "D5:2 B4:2",                 // Em
    "C5:1 F5:1 A5:1.5 G5:0.5",   // F
    "E5:1 C5:1 G4:2",            // C/E
    "A4:1 C5:1 D5:1 F5:1",       // Dm7
    "G5:1 D5:1 B4:1 G4:1",       // G
  ].join(" "),
  harmInst: "flute",
  harmony: [
    "_:4", "_:4",
    "E5:2 C5:2", "_:4",
    "_:4", "C5:2 E5:2",
    "_:4", "B4:2 D5:2",
  ].join(" "),
  groove: {
    kick: "x.....x..x......",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    clap: "....x.......x...",
    gain: 0.8,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "..x...x...x...x.", gain: 0.6 },
  // 6 サイクル ≒ 48 小節 ≒ 100s
  layers: [
    { pad: true, arp: true },                                  // イントロ（薄く）
    { pad: true, arp: true, bass: true, drums: true },         // ビルドアップ
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },// テーマ
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true }, // サビ
    { pad: true, bass: true, drums: true, mel: "A", harm: true },// 展開
    { pad: true, arp: true, bass: true, drums: true, mel: "B" },// サビ復帰→頭へ
  ],
};

// =========================================================================
//  曲 2 — OVAL "NEON HIGHWAY"  A minor→C / 158 BPM / 高速・都会的・爽快
//  デジタルブラス＋ブライトシンセ。一直線を全開で駆け抜ける疾走感。
// =========================================================================
const OVAL: SongDef = {
  bpm: 158,
  barsPerCycle: 8,
  chords: [
    "A3/C4/E4", "F3/A3/C4", "C4/E4/G4", "G3/B3/D4",
    "A3/C4/E4", "F3/A3/C4", "D3/F3/A3", "E3/G#3/B3",
  ],
  roots: ["A1", "F1", "C2", "G1", "A1", "F1", "D2", "E2"],
  bassStyle: "rockoct",
  bassInst: "bass",
  padInst: "strings",
  arpInst: "pluck",
  arpOrder: [0, 1, 2, 1, 0, 2, 1, 2],
  melInst: "brass",
  melodyA: [
    "A4:0.5 B4:0.5 C5:1 E5:1 D5:1",    // Am
    "C5:0.5 A4:0.5 F4:1 A4:2",         // F
    "G4:0.5 A4:0.5 G4:1 E5:1 C5:1",    // C
    "B4:1 D5:1 G5:2",                  // G
    "A4:0.5 B4:0.5 C5:1 E5:1 G5:1",    // Am
    "F5:1 E5:1 C5:2",                  // F
    "D5:0.5 E5:0.5 F5:1 A5:1 G5:1",    // D
    "E5:2 _:1 E5:0.5 G#4:0.5",         // E7 → A へ
  ].join(" "),
  melodyB: [
    "E5:1 A5:1 G5:0.5 E5:0.5 C5:1",    // Am 高域サビ
    "A5:2 F5:1 A5:1",                  // F
    "G5:1 E5:1 C5:0.5 D5:0.5 E5:1",    // C
    "D5:1 B4:1 D5:2",                  // G
    "C5:1 E5:1 A5:0.5 G5:0.5 E5:1",    // Am
    "F5:1 A5:1 C6:2",                  // F
    "B5:1 A5:1 F5:1 D5:1",             // D
    "E5:1 G#5:1 B5:1 E5:1",            // E7
  ].join(" "),
  harmInst: "lead",
  harmony: [
    "_:4", "_:4", "_:4", "_:4",
    "A5:0.5 _:3.5", "_:4", "_:4", "B5:1 _:3",
  ].join(" "),
  groove: {
    kick: "x...x...x...x...",
    snare: "....X.......X...",
    hat: "x.x.x.x.x.x.x.x.",
    ohat: "..x...x...x...x.",
    gain: 1.0,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "x.x.x.x.x.x.x.x.", gain: 0.7 },
  // 8 サイクル ≒ 64 小節 ≒ 97s
  layers: [
    { pad: true, arp: true },
    { pad: true, arp: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

// =========================================================================
//  曲 3 — BEGINNER "FIRST LAP FUN"  G major / 140 BPM / 元気・ポップ・少しコミカル
//  マリンバ＋エレピのバウンス。誰でも楽しく走れる明るいサーキット。
// =========================================================================
const BEGINNER: SongDef = {
  bpm: 140,
  barsPerCycle: 8,
  chords: [
    "G3/B3/D4", "C4/E4/G4", "D3/F#3/A3", "G3/B3/D4",
    "E3/G3/B3", "C4/E4/G4", "A3/C4/E4", "D3/F#3/A3",
  ],
  roots: ["G2", "C2", "D2", "G2", "E2", "C2", "A1", "D2"],
  bassStyle: "rockoct",
  bassInst: "bass",
  padInst: "pad",
  arpInst: "marimba",
  arpOrder: [0, 2, 1, 2, 0, 1, 2, 1],
  melInst: "epiano",
  melodyA: [
    "D4:0.5 G4:0.5 B4:1 D5:1 B4:1",    // G
    "C5:1 E5:1 G5:1 _:1",              // C
    "F#4:0.5 A4:0.5 D5:1 A4:1 F#4:1",  // D
    "G4:1 B4:1 D5:2",                  // G
    "E5:0.5 D5:0.5 B4:1 G4:1 B4:1",    // Em
    "C5:1 E5:1 C5:0.5 E5:0.5 G5:1",    // C
    "A4:1 C5:1 E5:1 A4:1",             // Am
    "F#4:1 A4:1 D5:1.5 C5:0.5",        // D → G
  ].join(" "),
  melodyB: [
    "G5:1 D5:0.5 B4:0.5 G4:1 B4:1",    // G コミカルに跳ねる
    "E5:1 C5:1 G4:2",                  // C
    "A4:0.5 D5:0.5 F#5:1 A5:1 F#5:1",  // D
    "G5:1 D5:1 B4:2",                  // G
    "B4:0.5 E5:0.5 G5:1 E5:1 B4:1",    // Em
    "C5:1 G5:1 E5:0.5 C5:0.5 E5:1",    // C
    "A4:1 E5:1 C5:1 A4:1",             // Am
    "D5:1 F#5:1 A5:1.5 G5:0.5",        // D
  ].join(" "),
  harmInst: "bell",
  harmony: [
    "_:4", "G5:1 _:3", "_:4", "_:4",
    "_:4", "_:4", "_:4", "D5:0.5 E5:0.5 _:3",
  ].join(" "),
  groove: {
    kick: "x..x..x.x..x....",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    clap: "....x.......x...",
    gain: 0.9,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "..x...x...x...x.", gain: 0.55 },
  // 7 サイクル ≒ 56 小節 ≒ 96s
  layers: [
    { pad: true, arp: true },
    { pad: true, arp: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "B" },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

// =========================================================================
//  曲 4 — TUNNEL "UNDERPASS NEON"  E minor / 158 BPM / 夜・ネオン・地下・クール
//  シンセアルペジオ主体＋電子音。地下高速を駆け抜ける近未来感。
// =========================================================================
const TUNNEL: SongDef = {
  bpm: 158,
  barsPerCycle: 8,
  chords: [
    "E3/G3/B3", "C4/E4/G4", "D3/F#3/A3", "B3/D4/F#4",
    "E3/G3/B3", "C4/E4/G4", "A3/C4/E4", "B3/D4/F#4",
  ],
  roots: ["E1", "C2", "D2", "B1", "E1", "C2", "A1", "B1"],
  bassStyle: "pump",
  bassInst: "bass",
  padInst: "pad",
  arpInst: "pluck",
  arpOrder: [0, 1, 2, 1, 2, 1, 0, 1],
  arpStep: 0.25,
  melInst: "lead",
  melodyA: [
    "B4:1 E5:1 D5:0.5 B4:0.5 G4:1",    // Em
    "C5:1 G5:1 E5:2",                  // C
    "A4:0.5 D5:0.5 F#5:1 D5:1 A4:1",   // D
    "B4:1 F#5:1 D5:2",                 // B
    "E5:0.5 G5:0.5 B5:1 A5:1 G5:1",    // Em
    "G5:1 E5:1 C5:2",                  // C
    "E5:0.5 A5:0.5 E5:1 C5:1 A4:1",    // Am
    "F#5:1 B4:1 D5:1 F#5:1",           // B → Em
  ].join(" "),
  melodyB: [
    "E5:0.5 B5:0.5 E5:0.5 B5:0.5 G5:1 E5:1", // Em 駆け上がり
    "G5:1 C6:1 G5:2",                  // C
    "F#5:0.5 A5:0.5 D6:1 A5:1 F#5:1",  // D
    "F#5:1 B5:1 F#5:2",                // B
    "B5:0.5 E6:0.5 D6:0.5 B5:0.5 G5:1 B5:1", // Em
    "E5:1 G5:1 C6:2",                  // C
    "E5:1 A5:1 C6:1 E6:1",             // Am
    "D6:1 B5:1 F#5:1 D5:1",            // B
  ].join(" "),
  harmInst: "bell",
  harmony: [
    "B5:0.25 _:0.75 _:3", "_:4", "_:4", "_:4",
    "E6:0.25 _:0.75 _:3", "_:4", "_:4", "_:4",
  ].join(" "),
  groove: {
    kick: "x...x...x...x...",
    snare: "....x.......x...",
    hat: "xxxxxxxxxxxxxxxx",
    ohat: "..x...x...x...x.",
    gain: 1.0,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "x.x.x.x.x.x.x.x.", gain: 0.7 },
  // 8 サイクル ≒ 64 小節 ≒ 97s
  layers: [
    { pad: true, arp: true },
    { pad: true, arp: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "B" },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

// =========================================================================
//  曲 5 — HIGHLAND "SUMMER RIDGELINE"  D major / 134 BPM / 青空・爽やか・開放感
//  フルート＋ストリングス＋軽快ドラム。避暑地の山道を気持ちよくドライブ。
// =========================================================================
const HIGHLAND: SongDef = {
  bpm: 134,
  barsPerCycle: 8,
  chords: [
    "D4/F#4/A4", "A3/C#4/E4", "B3/D4/F#4", "G3/B3/D4",
    "D4/F#4/A4", "G3/B3/D4", "E3/G3/B3", "A3/C#4/E4",
  ],
  roots: ["D2", "A1", "B1", "G1", "D2", "G1", "E2", "A1"],
  bassStyle: "quarter",
  bassInst: "bass",
  padInst: "strings",
  arpInst: "pluck",
  arpOrder: [0, 1, 2, 1],
  melInst: "flute",
  melGain: 0.9,
  melodyA: [
    "A4:1 D5:1 F#5:1.5 E5:0.5",        // D
    "E5:1 C#5:1 A4:2",                 // A
    "B4:1 D5:1 F#5:1 B5:1",            // Bm
    "A5:2 G5:2",                       // G
    "F#5:1 A5:1 D6:1.5 C#6:0.5",       // D
    "B5:1 G5:1 D5:2",                  // G
    "E5:1 G5:1 B5:1 G5:1",             // Em
    "A5:1 E5:1 C#5:1.5 A4:0.5",        // A → D
  ].join(" "),
  melodyB: [
    "D5:1 F#5:1 A5:1 D6:1",            // D 開放的に
    "C#6:1.5 A5:0.5 E5:2",             // A
    "B5:1 F#5:1 D5:0.5 F#5:0.5 B5:1",  // Bm
    "D6:2 B5:2",                       // G
    "A5:1 D6:1 F#6:1.5 E6:0.5",        // D
    "D6:1 B5:1 G5:2",                  // G
    "G5:1 B5:1 E6:1 B5:1",             // Em
    "E6:1 C#6:1 A5:1.5 F#5:0.5",       // A
  ].join(" "),
  harmInst: "marimba",
  harmony: [
    "_:4", "_:4", "_:4", "_:4",
    "D5:0.5 F#5:0.5 _:3", "_:4", "_:4", "_:4",
  ].join(" "),
  groove: {
    kick: "x.....x.x.......",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    ohat: "......x.......x.",
    gain: 0.82,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "..x...x...x...x.", gain: 0.5 },
  // 7 サイクル ≒ 56 小節 ≒ 100s
  layers: [
    { pad: true, arp: true },
    { pad: true, arp: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, bass: true, drums: true, mel: "B" },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

// =========================================================================
//  曲 6 — FOREST "FOREST SPRING"  F major / 128 BPM / 緑・木漏れ日・癒し・可愛い
//  マリンバ＋ベル＋フルート。森の中を楽しく走る優しい雰囲気。
// =========================================================================
const FOREST: SongDef = {
  bpm: 128,
  barsPerCycle: 8,
  chords: [
    "F3/A3/C4", "C4/E4/G4", "D3/F3/A3", "Bb3/D4/F4",
    "F3/A3/C4", "A3/C4/E4", "Bb3/D4/F4", "C4/E4/G4",
  ],
  roots: ["F2", "C2", "D2", "Bb1", "F2", "A1", "Bb1", "C2"],
  bassStyle: "half",
  bassInst: "bass",
  padInst: "pad",
  arpInst: "marimba",
  arpOrder: [0, 1, 2, 1, 0, 2, 1, 2],
  melInst: "bell",
  melGain: 0.8,
  melodyA: [
    "C5:1 F5:1 A5:1 G5:1",             // F
    "E5:1 G5:1 C5:2",                  // C
    "F5:1 A5:1 D5:0.5 F5:0.5 A5:1",    // Dm
    "Bb4:1 D5:1 F5:2",                 // Bb
    "A4:1 C5:1 F5:1.5 E5:0.5",         // F
    "C5:1 E5:1 A5:2",                  // Am
    "D5:1 F5:1 Bb5:1 A5:1",            // Bb
    "G5:1 E5:1 C5:1.5 G4:0.5",         // C → F
  ].join(" "),
  melodyB: [
    "F5:0.5 A5:0.5 C6:1 A5:1 F5:1",    // F くるくる可愛く
    "G5:1 E5:1 G5:2",                  // C
    "A5:0.5 F5:0.5 D5:1 F5:1 A5:1",    // Dm
    "Bb5:1 A5:1 F5:2",                 // Bb
    "C6:1 A5:1 F5:0.5 A5:0.5 C6:1",    // F
    "E5:1 A5:1 C6:2",                  // Am
    "D5:1 Bb5:1 D6:1 Bb5:1",           // Bb
    "C6:1 G5:1 E5:1.5 C5:0.5",         // C
  ].join(" "),
  harmInst: "flute",
  harmony: [
    "_:4", "_:4", "_:4", "_:4",
    "F5:1 A5:1 _:2", "_:4", "_:4", "_:4",
  ].join(" "),
  groove: {
    kick: "x.....x...x.....",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    gain: 0.72,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "..x...x...x...x.", gain: 0.45 },
  // 7 サイクル ≒ 56 小節 ≒ 105s
  layers: [
    { pad: true, arp: true },
    { pad: true, arp: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "B" },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

// =========================================================================
//  曲 7 — TOUGE "MOUNTAIN ATTACK"  E minor / 150 BPM / テクニカル・熱い・スリル
//  ロックリード（歪み）＋パワーベース。コーナーを次々攻略する高揚感。
// =========================================================================
const TOUGE: SongDef = {
  bpm: 150,
  barsPerCycle: 8,
  chords: [
    "E3/G3/B3", "D3/F#3/A3", "C4/E4/G4", "B3/D4/F#4",
    "E3/G3/B3", "G3/B3/D4", "A3/C4/E4", "B3/D4/F#4",
  ],
  roots: ["E1", "D2", "C2", "B1", "E1", "G1", "A1", "B1"],
  bassStyle: "rockoct",
  bassInst: "bass",
  padInst: "strings",
  arpInst: "pluck",
  arpOrder: [0, 1, 2, 1, 0, 2, 1, 2],
  melInst: "rock",
  melGain: 0.8,
  melodyA: [
    "E5:0.5 G5:0.5 B5:1 A5:0.5 G5:0.5 E5:1", // Em 攻める
    "F#5:1 A5:1 D5:2",                 // D
    "G5:0.5 E5:0.5 C5:1 G5:1 E5:1",    // C
    "F#5:1 B5:1 F#5:2",                // B
    "B5:0.5 E6:0.5 D6:1 B5:0.5 A5:0.5 G5:1", // Em
    "B5:1 G5:1 D5:2",                  // G
    "C6:1 A5:1 E5:0.5 A5:0.5 C6:1",    // Am
    "B5:1 F#5:1 D5:1 B4:1",            // B → Em
  ].join(" "),
  melodyB: [
    "B5:1 E6:1 D6:0.5 B5:0.5 G5:1",    // Em ハイギア
    "A5:1 D6:1 F#5:2",                 // D
    "G5:1 C6:1 E6:0.5 C6:0.5 G5:1",    // C
    "F#5:1 B5:1 D6:2",                 // B
    "E6:0.5 G6:0.5 B6:1 A6:1 G6:1",    // Em
    "D6:1 B5:1 G5:2",                  // G
    "E6:1 C6:1 A5:2",                  // Am
    "F#5:0.5 A5:0.5 B5:1 D6:1 F#6:1",  // B
  ].join(" "),
  harmInst: "brass",
  harmony: [
    "E4:1 _:3", "D4:1 _:3", "C4:1 _:3", "B3:1 _:3",
    "E4:2 _:2", "G4:1 _:3", "A4:1 _:3", "B3:2 _:2",
  ].join(" "),
  groove: {
    kick: "x..x..x.x..x..x.",
    snare: "....X.......X...",
    hat: "x.x.x.x.x.x.x.x.",
    ohat: "..x...x...x...x.",
    gain: 1.05,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "x.x.x.x.x.x.x.x.", gain: 0.7 },
  // 8 サイクル ≒ 64 小節 ≒ 102s
  layers: [
    { pad: true, arp: true },
    { pad: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

// =========================================================================
//  曲 8 — CIRCUIT "FINAL VICTORY"  A minor / 165 BPM / 緊張感・最後の決戦・かっこいい
//  シンセリード＋ブラス＋重めドラム。シリーズ最後の決戦を感じさせる熱いレース曲。
// =========================================================================
const CIRCUIT: SongDef = {
  bpm: 165,
  barsPerCycle: 8,
  chords: [
    "A3/C4/E4", "E3/G#3/B3", "F3/A3/C4", "C4/E4/G4",
    "D3/F3/A3", "A3/C4/E4", "B3/D4/F#4", "E3/G#3/B3",
  ],
  roots: ["A1", "E2", "F1", "C2", "D2", "A1", "B1", "E2"],
  bassStyle: "rockoct",
  bassInst: "bass",
  padInst: "strings",
  arpInst: "pluck",
  arpOrder: [0, 1, 2, 1, 2, 1, 0, 2],
  melInst: "lead",
  melGain: 0.82,
  melodyA: [
    "A4:0.5 C5:0.5 E5:1 A5:0.5 G5:0.5 E5:1", // Am 緊迫
    "E5:1 G#5:1 B5:2",                 // E
    "C5:0.5 A4:0.5 F5:1 A5:1 F5:1",    // F
    "G5:1 E5:1 C5:2",                  // C
    "A5:0.5 F5:0.5 D5:1 F5:1 A5:1",    // Dm
    "C6:1 A5:1 E5:2",                  // Am
    "B5:1 F#5:1 D5:0.5 F#5:0.5 B5:1",  // B
    "B5:1 G#5:1 E5:1 B4:1",            // E → Am
  ].join(" "),
  melodyB: [
    "E5:1 A5:1 C6:0.5 A5:0.5 E5:1",    // Am クライマックス
    "G#5:1 B5:1 E6:2",                 // E
    "A5:1 C6:1 F5:0.5 A5:0.5 C6:1",    // F
    "G5:1 C6:1 E6:2",                  // C
    "D6:1 A5:1 F5:0.5 A5:0.5 D6:1",    // Dm
    "C6:1 E6:1 A6:2",                  // Am
    "F#6:1 D6:1 B5:2",                 // B
    "E6:1 B5:1 G#5:1 E5:1",            // E
  ].join(" "),
  harmInst: "brass",
  harmony: [
    "A4:1 _:3", "G#4:1 _:3", "A4:1 _:3", "G4:1 _:3",
    "F4:1 _:3", "E4:1 _:3", "F#4:1 _:3", "B3:2 _:2",
  ].join(" "),
  groove: {
    kick: "x..x.x..x..x.x..",
    snare: "....X.......X...",
    hat: "xxxxxxxxxxxxxxxx",
    ohat: "..x...x...x...x.",
    gain: 1.1,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "x.x.x.x.x.x.x.x.", gain: 0.7 },
  // 8 サイクル ≒ 64 小節 ≒ 93s
  layers: [
    { pad: true, arp: true },
    { pad: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, bass: true, drums: true, mel: "B" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

// =========================================================================
//  曲 9 — SUZUKA "GRAND PRIX HERO"  D minor / 155 BPM / 英雄的・壮大・本気の決戦
//  ブラスリード＋ストリングス＋ドライブベース。シリーズ最長のスペシャルコースに
//  ふさわしい、高揚と威厳のあるグランプリ・テーマ（完全オリジナル）。
// =========================================================================
const SUZUKA: SongDef = {
  bpm: 155,
  barsPerCycle: 8,
  // Dm  Bb  F  C  Gm  Bb  C  A(7)  （ヒロイックな短調進行＋ドミナント A で頭へ）
  chords: [
    "D4/F4/A4", "Bb3/D4/F4", "F3/A3/C4", "C4/E4/G4",
    "G3/Bb3/D4", "Bb3/D4/F4", "C4/E4/G4", "A3/C#4/E4",
  ],
  roots: ["D2", "Bb1", "F1", "C2", "G1", "Bb1", "C2", "A1"],
  bassStyle: "rockoct",
  bassInst: "bass",
  padInst: "strings",
  arpInst: "pluck",
  arpOrder: [0, 1, 2, 1, 2, 1, 0, 2],
  melInst: "brass",
  melGain: 0.82,
  melodyA: [
    "D5:1 A4:0.5 D5:0.5 F5:1 E5:1",     // Dm 主題
    "D5:1 F5:1 Bb5:2",                  // Bb
    "C5:0.5 F5:0.5 A5:1 G5:1 F5:1",     // F
    "E5:1 G5:1 C5:2",                   // C
    "D5:0.5 G5:0.5 Bb5:1 A5:1 G5:1",    // Gm
    "F5:1 D5:1 Bb4:2",                  // Bb
    "C5:0.5 E5:0.5 G5:1 E5:1 C5:1",     // C
    "E5:1 C#5:1 A4:2",                  // A → Dm
  ].join(" "),
  melodyB: [
    "A5:1 D6:1 C6:0.5 A5:0.5 F5:1",     // Dm クライマックス
    "Bb5:1 D6:1 F6:2",                  // Bb
    "A5:1 C6:1 A5:0.5 F5:0.5 C6:1",     // F
    "G5:1 C6:1 E6:2",                   // C
    "D6:1 Bb5:1 G5:0.5 Bb5:0.5 D6:1",   // Gm
    "F6:1 D6:1 Bb5:2",                  // Bb
    "E6:1 C6:1 G5:2",                   // C
    "A5:1 E5:1 C#5:1 E5:1",             // A
  ].join(" "),
  harmInst: "lead",
  harmony: [
    "D4:1 _:3", "F4:1 _:3", "E4:1 _:3", "G4:1 _:3",
    "Bb3:1 _:3", "D4:1 _:3", "E4:1 _:3", "A3:2 _:2",
  ].join(" "),
  groove: {
    kick: "x..x..x.x..x..x.",
    snare: "....X.......X...",
    hat: "x.x.x.x.x.x.x.x.",
    ohat: "..x...x...x...x.",
    gain: 1.05,
  },
  grooveSoft: { kick: "x.......x.......", snare: "", hat: "x.x.x.x.x.x.x.x.", gain: 0.7 },
  // 8 サイクル ≒ 64 小節 ≒ 99s
  layers: [
    { pad: true, arp: true },
    { pad: true, bass: true, drums: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "A", harm: true },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, bass: true, drums: true, mel: "A" },
    { pad: true, arp: true, bass: true, drums: true, mel: "B", harm: true },
    { pad: true, arp: true, bass: true, drums: true },
  ],
};

/** 画面/コース → 曲 */
export const SONGS: Record<
  | "menu" | "oval" | "beginner" | "tunnel" | "highland" | "forest" | "touge"
  | "circuit" | "suzuka",
  Song
> = {
  menu: render(MENU),
  oval: render(OVAL),
  beginner: render(BEGINNER),
  tunnel: render(TUNNEL),
  highland: render(HIGHLAND),
  forest: render(FOREST),
  touge: render(TOUGE),
  circuit: render(CIRCUIT),
  suzuka: render(SUZUKA),
};
