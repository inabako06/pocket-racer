import { CarTuning } from "./CarTuning";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * HTML 要素を直接操作する HUD。
 * Three.js のレンダリングとは独立して DOM を更新する。
 *
 * 左上: ラップ / スピード / FPS
 * 中央: GO! / GOAL! / 3-2-1 カウントダウン / WRONG WAY
 * 右中央: ギア段
 * 右下: タコメータ（回転数）＋数値速度
 */
export class HUD {
  private readonly posEl: HTMLElement;
  private readonly lapEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly lapTimesEl: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly centerEl: HTMLElement;
  private readonly pauseEl: HTMLElement;
  private readonly gearEl: HTMLElement;
  private readonly tachSpeedEl: HTMLElement;
  private readonly rpmEl: HTMLElement;
  private readonly needleEl: SVGGElement;

  // リザルト画面
  private readonly resultEl: HTMLElement;
  private readonly resultTitleEl: HTMLElement;
  private readonly resultArcadeEl: HTMLElement;
  private readonly resultTableEl: HTMLElement;
  private readonly resultTimeEl: HTMLElement;
  private readonly resultLapsEl: HTMLElement;
  private readonly resultSubEl: HTMLElement;

  // ミニマップ
  private readonly miniCanvas: HTMLCanvasElement;
  private readonly miniCtx: CanvasRenderingContext2D;
  private miniPts: { x: number; y: number }[] = [];
  private miniProject: ((x: number, z: number) => { x: number; y: number }) | null =
    null;

  // FPS 平滑化用
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsValue = 60;

  // タコメータの針の角度範囲（真上を0°とした左右の振り角）
  private static readonly NEEDLE_START = -100;
  private static readonly NEEDLE_END = 100;

  constructor() {
    this.posEl = HUD.byId("hud-pos");
    this.lapEl = HUD.byId("hud-lap");
    this.timeEl = HUD.byId("hud-time");
    this.lapTimesEl = HUD.byId("hud-laptimes");
    this.fpsEl = HUD.byId("hud-fps");
    this.centerEl = HUD.byId("hud-center");
    this.pauseEl = HUD.byId("pause-overlay");
    this.gearEl = HUD.byId("hud-gear-val");
    this.tachSpeedEl = HUD.byId("tach-speed-val");
    this.rpmEl = HUD.byId("tach-rpm");
    this.needleEl = this.buildTachGauge(HUD.byId("tach-gauge"));

    this.miniCanvas = HUD.byId("minimap") as HTMLCanvasElement;
    this.miniCtx = this.miniCanvas.getContext("2d")!;

    this.resultEl = HUD.byId("result");
    this.resultTitleEl = HUD.byId("result-title");
    this.resultArcadeEl = HUD.byId("result-arcade");
    this.resultTableEl = HUD.byId("result-table");
    this.resultTimeEl = HUD.byId("result-time");
    this.resultLapsEl = HUD.byId("result-laps");
    this.resultSubEl = HUD.byId("result-sub");
  }

  private static byId(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`HUD element not found: #${id}`);
    return el;
  }

  /** タコメータの目盛り・針をSVGで生成。針の <g> を返す。 */
  private buildTachGauge(container: HTMLElement): SVGGElement {
    const cx = 50;
    const cy = 54;
    const rIn = 37;
    const rOut = 46;
    const needleLen = 40;
    const ticks = 8; // 0〜8（×1000rpm 相当）
    const redlineFrac = CarTuning.RedlineRpm / CarTuning.MaxRpm;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 64");

    const line = (
      x1: number, y1: number, x2: number, y2: number,
      color: string, w: number
    ): SVGLineElement => {
      const l = document.createElementNS(SVG_NS, "line");
      l.setAttribute("x1", `${x1}`);
      l.setAttribute("y1", `${y1}`);
      l.setAttribute("x2", `${x2}`);
      l.setAttribute("y2", `${y2}`);
      l.setAttribute("stroke", color);
      l.setAttribute("stroke-width", `${w}`);
      l.setAttribute("stroke-linecap", "round");
      return l;
    };

    // 目盛り
    for (let i = 0; i <= ticks; i++) {
      const f = i / ticks;
      const deg =
        HUD.NEEDLE_START + (HUD.NEEDLE_END - HUD.NEEDLE_START) * f;
      const rad = (deg * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);
      const red = f >= redlineFrac;
      svg.appendChild(
        line(
          cx + dx * rIn, cy + dy * rIn,
          cx + dx * rOut, cy + dy * rOut,
          red ? "#ff4040" : "#cfcfcf",
          red ? 2.6 : 1.6
        )
      );
    }

    // 針（グループごと回転させる）
    const needle = document.createElementNS(SVG_NS, "g");
    needle.appendChild(line(cx, cy, cx, cy - needleLen, "#ffd23f", 2.6));
    svg.appendChild(needle);

    // 中心ハブ
    const hub = document.createElementNS(SVG_NS, "circle");
    hub.setAttribute("cx", `${cx}`);
    hub.setAttribute("cy", `${cy}`);
    hub.setAttribute("r", "3.2");
    hub.setAttribute("fill", "#888");
    svg.appendChild(hub);

    container.appendChild(svg);
    // 初期位置（アイドル）
    needle.setAttribute("transform", `rotate(${HUD.NEEDLE_START} ${cx} ${cy})`);
    // 回転中心を記録するため属性に保持（update時に再利用）
    needle.dataset.cx = `${cx}`;
    needle.dataset.cy = `${cy}`;
    return needle;
  }

  setLap(current: number, total: number): void {
    this.lapEl.textContent = `LAP ${current}/${total}`;
  }

  /** 順位（プレイヤーの現在順位 / 出場台数） */
  setPosition(pos: number, total: number): void {
    this.posEl.textContent = `POS ${pos}/${total}`;
  }

  /** 速度表示（右下タコメータのみ。左上の速度表示は廃止） */
  setSpeed(kmh: number): void {
    this.tachSpeedEl.textContent = String(Math.round(kmh));
  }

  /** 秒数を m:ss.cc 形式に */
  private static fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  }

  /** スタートからの累計レースタイム */
  setRaceTime(sec: number): void {
    this.timeEl.textContent = HUD.fmtTime(sec);
  }

  /** 各周回のラップタイム一覧（速い順ではなく周回順） */
  setLapTimes(times: number[]): void {
    this.lapTimesEl.innerHTML = times
      .map((t, i) => `LAP${i + 1} ${HUD.fmtTime(t)}`)
      .join("<br>");
  }

  /** リザルト画面：最終順位の表＋自分のレースタイム＋ラップタイムを出す */
  showResult(
    rows: { pos: number; name: string; isPlayer: boolean; time: number | null }[],
    totalTime: number,
    lapTimes: number[],
    arcade?: {
      position: number;
      courseNumber: number;
      totalCourses: number;
      gameOver: boolean;
      isFinal: boolean;
    }
  ): void {
    // タイトル / アーケード情報 / フッターをモードに応じて切り替える
    if (arcade) {
      this.resultTitleEl.textContent = arcade.gameOver ? "GAME OVER" : "RESULT";
      const goal = arcade.gameOver
        ? "OUT — finish in the top 3 to advance"
        : "TOP 3 — advancing";
      this.resultArcadeEl.innerHTML =
        `<div class="ar-course">COURSE ${arcade.courseNumber} / ${arcade.totalCourses}</div>` +
        `<div class="ar-line">FINISHED P${arcade.position}</div>` +
        `<div class="ar-goal${arcade.gameOver ? " out" : ""}">${goal}</div>`;
      this.resultSubEl.textContent = arcade.gameOver
        ? "Click to return to title"
        : arcade.isFinal
          ? "Click to return to title"
          : "Click for the next course";
    } else {
      this.resultTitleEl.textContent = "RESULT";
      this.resultArcadeEl.innerHTML = "";
      this.resultSubEl.textContent = "Click to return to title";
    }

    this.resultTableEl.innerHTML = rows
      .map(
        (r) =>
          `<div class="result-row${r.isPlayer ? " you" : ""}">` +
          `<span class="rp">${r.pos}</span>` +
          `<span class="rn">${r.name}${r.isPlayer ? " (YOU)" : ""}</span>` +
          `<span class="rt">${r.time != null ? HUD.fmtTime(r.time) : "--"}</span>` +
          `</div>`
      )
      .join("");
    this.resultTimeEl.textContent = `RACE TIME  ${HUD.fmtTime(totalTime)}`;
    this.resultLapsEl.innerHTML = lapTimes
      .map((t, i) => `LAP${i + 1} ${HUD.fmtTime(t)}`)
      .join("  ·  ");
    this.resultEl.classList.add("show");
  }

  /** ミニマップ初期化：中心線からキャンバス座標への射影を作る */
  setupMinimap(centerline: { x: number; z: number }[]): void {
    const w = this.miniCanvas.width;
    const h = this.miniCanvas.height;
    const pad = 12;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of centerline) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const spanX = maxX - minX || 1;
    const spanZ = maxZ - minZ || 1;
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanZ);
    const offX = (w - spanX * scale) / 2;
    const offZ = (h - spanZ * scale) / 2;
    this.miniProject = (x: number, z: number) => ({
      x: offX + (x - minX) * scale,
      y: offZ + (z - minZ) * scale,
    });
    this.miniPts = centerline.map((p) => this.miniProject!(p.x, p.z));
  }

  /** ミニマップ更新：コース＋自車(赤)・ライバル(緑)の点を描く */
  updateMinimap(
    player: { x: number; z: number },
    rivals: { x: number; z: number }[]
  ): void {
    if (!this.miniProject) return;
    const ctx = this.miniCtx;
    const w = this.miniCanvas.width;
    const h = this.miniCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // コース（中心線）
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    this.miniPts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();

    const dot = (x: number, z: number, color: string, r: number): void => {
      const p = this.miniProject!(x, z);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    // ライバル（緑）→ 自車（赤）の順で、自車を前面に
    for (const r of rivals) dot(r.x, r.z, "#33dd55", 3.4);
    dot(player.x, player.z, "#ff3b30", 4);
  }

  /** ギア段の表示（"1"〜"6" または "R"） */
  setGear(label: string): void {
    this.gearEl.textContent = label;
  }

  /** 回転数の表示（数値＋針の角度） */
  setRpm(rpm: number, rpmNorm: number): void {
    this.rpmEl.textContent = `${Math.round(rpm / 10) * 10} rpm`;
    const deg =
      HUD.NEEDLE_START + (HUD.NEEDLE_END - HUD.NEEDLE_START) * rpmNorm;
    const cx = this.needleEl.dataset.cx ?? "50";
    const cy = this.needleEl.dataset.cy ?? "54";
    this.needleEl.setAttribute("transform", `rotate(${deg} ${cx} ${cy})`);
  }

  /** dt から FPS を平滑化して表示（約0.25秒ごとに更新） */
  updateFps(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.25) {
      this.fpsValue = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.fpsEl.textContent = `FPS ${this.fpsValue}`;
    }
  }

  /** 中央メッセージ表示（空文字で非表示） */
  showCenter(text: string): void {
    if (text) {
      this.centerEl.textContent = text;
      this.centerEl.classList.add("show");
    } else {
      this.centerEl.classList.remove("show");
    }
  }

  setPaused(paused: boolean): void {
    this.pauseEl.classList.toggle("show", paused);
  }
}
