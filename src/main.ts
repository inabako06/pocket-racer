import { Game } from "./Game";
import { CarTuning } from "./CarTuning";
import type { TrackId } from "./RaceTrack";
import { music } from "./MusicPlayer";
import { initCarPreviews } from "./CarPreview";

/**
 * エントリポイント。
 * 「モード選択 → (アーケードなら難易度選択) → マイカー選択 → コース」の順に進む。
 *
 * - FREE RUN: 従来どおり 1 コースを選んで単発レース。
 * - ARCADE: 難易度ごとに決まった 4 コースを連戦。毎レース **3位以内**なら次コースへ、
 *   4位以下はその場でゲームオーバー（ポイント制は廃止）。
 *
 * アーケードの進行（難易度/車/何コース目）は sessionStorage に保存し、
 * 各コース間は location.reload() で挟む（Game は破棄処理を持たないため、
 * リロードで完全リセットしてから次コースを開始するのが安全）。リロード後、
 * 保存状態があれば自動的に次コースへ入る。
 */
const canvas = document.getElementById("game-canvas") as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error("game-canvas element not found");
}

// 開発中の調整用：コンソールから CarTuning.EnginePower = 1000 等で即変更できる
(window as unknown as { CarTuning: typeof CarTuning }).CarTuning = CarTuning;

const modeSelect = document.getElementById("mode-select");
const diffSelect = document.getElementById("difficulty-select");
const carSelect = document.getElementById("car-select");
const courseSelect = document.getElementById("course-select");
const result = document.getElementById("result");

type Difficulty = "beginner" | "expert";

/** 難易度ごとのアーケード4コース（出走順） */
const ARCADE_COURSES: Record<Difficulty, TrackId[]> = {
  beginner: ["oval", "beginner", "highland", "tunnel"],
  expert: ["tunnelLong", "forest", "touge", "circuit"],
};

/** アーケード進行の保存形（sessionStorage） */
interface ArcadeState {
  difficulty: Difficulty;
  carId: string;
  /** 現在のコース番号（0始まり） */
  courseIndex: number;
}
const ARCADE_KEY = "pocket-arcade";

let currentGame: Game | null = null;
let started = false;

// 現在のメニューフロー（車選択後の分岐に使う）
let flow: "arcade" | "free" = "free";
let pendingDifficulty: Difficulty = "beginner";
let chosenCar = "lion";

function hideAllMenus(): void {
  modeSelect?.classList.add("hidden");
  diffSelect?.classList.add("hidden");
  carSelect?.classList.add("hidden");
  courseSelect?.classList.add("hidden");
}

function show(el: HTMLElement | null): void {
  hideAllMenus();
  el?.classList.remove("hidden");
}

// --- レース開始 ---------------------------------------------------------

function startFreeRun(trackId: TrackId): void {
  if (started) return;
  started = true;
  sessionStorage.removeItem(ARCADE_KEY);
  hideAllMenus();
  currentGame = new Game(canvas as HTMLCanvasElement, trackId, chosenCar);
  currentGame.start();
}

function startArcadeCourse(state: ArcadeState): void {
  if (started) return;
  started = true;
  // リロードを跨いで再開できるよう、開始時点の状態を保存
  sessionStorage.setItem(ARCADE_KEY, JSON.stringify(state));
  hideAllMenus();
  const courses = ARCADE_COURSES[state.difficulty];
  const trackId = courses[state.courseIndex];
  currentGame = new Game(canvas as HTMLCanvasElement, trackId, state.carId, {
    courseIndex: state.courseIndex,
    totalCourses: courses.length,
  });
  currentGame.start();
}

// --- リザルト画面クリック ----------------------------------------------
result?.addEventListener("click", () => {
  const outcome = currentGame?.arcadeOutcome ?? null;
  if (!outcome) {
    // フリーラン：最初の画面（モード選択）へ
    sessionStorage.removeItem(ARCADE_KEY);
    window.location.reload();
    return;
  }
  if (outcome.gameOver || outcome.isFinal) {
    // ゲームオーバー or 最終コール後：最初の画面へ戻る
    sessionStorage.removeItem(ARCADE_KEY);
    window.location.reload();
    return;
  }
  // 次コースへ：コース番号を進めて保存し、リロードで再開
  const raw = sessionStorage.getItem(ARCADE_KEY);
  if (raw) {
    const state = JSON.parse(raw) as ArcadeState;
    state.courseIndex += 1;
    sessionStorage.setItem(ARCADE_KEY, JSON.stringify(state));
  }
  window.location.reload();
});

// --- BGM：最初のユーザー操作でメニュー曲を鳴らす（自動再生制限の回避）------
// レースに入ると Game 側がコース曲へ差し替える。アーケード続行で起動した
// 場合（started=true）はメニュー曲を鳴らさず、AudioContext の resume だけ行う。
function primeMenuMusic(): void {
  if (!started) music.play("menu");
  else music.resumeOnGesture();
}
window.addEventListener("pointerdown", primeMenuMusic);
window.addEventListener("keydown", primeMenuMusic);

// --- メニュー操作（クリック）-------------------------------------------

// モード選択
modeSelect?.querySelectorAll<HTMLElement>(".course-card").forEach((card) => {
  card.addEventListener("click", () => pickMode(card.dataset.mode ?? "free"));
});

// 難易度選択（アーケード）
diffSelect?.querySelectorAll<HTMLElement>(".course-card").forEach((card) => {
  card.addEventListener("click", () =>
    pickDifficulty((card.dataset.diff as Difficulty) ?? "beginner")
  );
});

// 車選択
carSelect?.querySelectorAll<HTMLElement>(".car-card").forEach((card) => {
  card.addEventListener("click", () => pickCar(card.dataset.car ?? "lion"));
});

// コース選択（フリーランのみ）
courseSelect?.querySelectorAll<HTMLElement>(".course-card").forEach((card) => {
  card.addEventListener("click", () =>
    startFreeRun((card.dataset.track as TrackId) ?? "oval")
  );
});

function pickMode(mode: string): void {
  if (mode === "arcade") {
    flow = "arcade";
    show(diffSelect);
  } else {
    flow = "free";
    show(carSelect);
  }
}

function pickDifficulty(diff: Difficulty): void {
  pendingDifficulty = diff;
  flow = "arcade";
  show(carSelect);
}

function pickCar(carId: string): void {
  chosenCar = carId;
  if (flow === "arcade") {
    startArcadeCourse({
      difficulty: pendingDifficulty,
      carId,
      courseIndex: 0,
    });
  } else {
    show(courseSelect);
  }
}

// --- キーボード操作（表示中の画面に応じて）------------------------------
const CAR_KEYS: Record<string, string> = {
  "1": "lion",
  "2": "hawk",
  "3": "whale",
  "4": "piranha",
  "5": "wyvern",
};
const FREE_TRACK_KEYS: Record<string, TrackId> = {
  "1": "oval",
  "2": "beginner",
  "3": "tunnel",
  "4": "tunnelLong",
  "5": "highland",
  "6": "touge",
  "7": "forest",
  "8": "circuit",
  "9": "suzuka",
  "0": "shutoko",
};

function visible(el: HTMLElement | null): boolean {
  return !!el && !el.classList.contains("hidden");
}

window.addEventListener("keydown", (e) => {
  if (started) return;
  if (visible(modeSelect)) {
    if (e.key === "1") pickMode("arcade");
    else if (e.key === "2") pickMode("free");
  } else if (visible(diffSelect)) {
    if (e.key === "1") pickDifficulty("beginner");
    else if (e.key === "2") pickDifficulty("expert");
  } else if (visible(carSelect)) {
    const car = CAR_KEYS[e.key];
    if (car) pickCar(car);
  } else if (visible(courseSelect)) {
    const track = FREE_TRACK_KEYS[e.key];
    if (track) startFreeRun(track);
  }
});

// --- 起動：アーケード続行中ならメニューを飛ばして次コースへ ----------------
function boot(): void {
  const raw = sessionStorage.getItem(ARCADE_KEY);
  if (raw) {
    try {
      const state = JSON.parse(raw) as ArcadeState;
      const courses = ARCADE_COURSES[state.difficulty];
      if (
        courses &&
        state.courseIndex >= 0 &&
        state.courseIndex < courses.length
      ) {
        startArcadeCourse(state);
        return;
      }
    } catch {
      /* 壊れた保存値は破棄してメニューへ */
    }
    sessionStorage.removeItem(ARCADE_KEY);
  }
  show(modeSelect);
}

// 車選択カードに 3D プレビュー（ホバーで横回転）を仕込む
if (carSelect) initCarPreviews(carSelect);

boot();
