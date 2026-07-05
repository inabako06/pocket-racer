import { virtualInput } from "./Input";

/**
 * スマホ向けのタッチ操作ボタン。
 * index.html の #touch-controls（ステアパッド／GAS・BRK／CAM・SND・PAUSE）を
 * Pointer Events で配線し、virtualInput へ書き込む（Input がキーボードと OR する）。
 *
 * - タッチデバイス（pointer: coarse か maxTouchPoints > 0）でのみ有効化し、
 *   body に .touch を付けて CSS 側の表示・HUD 縮小を切り替える。
 * - デスクトップでのデバッグ用に URL に ?touch を付けると強制有効化できる。
 * - ステアは左右 2 分割の 1 枚パッドで、指をスライドすると左右が切り替わる
 *   （ボタン間の持ち替えより素早い切り返しができる）。マルチタッチ対応。
 */
export function initTouchControls(): void {
  const force = new URLSearchParams(window.location.search).has("touch");
  const isTouch =
    force ||
    window.matchMedia("(pointer: coarse)").matches ||
    navigator.maxTouchPoints > 0;
  if (!isTouch) return;

  const root = document.getElementById("touch-controls");
  if (!root) return;
  document.body.classList.add("touch");

  // 指がボタン外へ滑り出ても押下を追跡し続ける。
  // （合成イベントや解放済みポインターでは例外になるので握りつぶす）
  const capture = (el: Element, pointerId: number): void => {
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* noop */
    }
  };

  // 長押しのコンテキストメニュー／選択を抑止
  root.addEventListener("contextmenu", (e) => e.preventDefault());

  // ダブルタップ/ピンチによるページ拡大の保険（主対策は CSS の touch-action:
  // manipulation。iOS Safari は viewport の user-scalable=no を無視するため）
  document.addEventListener("dblclick", (e) => e.preventDefault());
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // --- ステアパッド（左右2分割・スライドで切り替え・マルチタッチ） ---
  const pad = document.getElementById("tc-steer");
  const halfL = document.getElementById("tc-steer-left");
  const halfR = document.getElementById("tc-steer-right");
  if (pad && halfL && halfR) {
    const pointers = new Map<number, "left" | "right">();

    const dirOf = (e: PointerEvent): "left" | "right" => {
      const r = pad.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2 ? "left" : "right";
    };
    const sync = (): void => {
      const dirs = [...pointers.values()];
      virtualInput.steerLeft = dirs.includes("left");
      virtualInput.steerRight = dirs.includes("right");
      halfL.classList.toggle("pressed", virtualInput.steerLeft);
      halfR.classList.toggle("pressed", virtualInput.steerRight);
    };

    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      virtualInput.anyTouch = true;
      capture(pad, e.pointerId);
      pointers.set(e.pointerId, dirOf(e));
      sync();
    });
    pad.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, dirOf(e));
      sync();
    });
    const release = (e: PointerEvent): void => {
      if (!pointers.delete(e.pointerId)) return;
      sync();
    };
    pad.addEventListener("pointerup", release);
    pad.addEventListener("pointercancel", release);
  }

  // --- 押している間だけ有効なボタン（GAS / BRK） ---
  type HoldKey = "accel" | "brake";
  root.querySelectorAll<HTMLElement>("[data-hold]").forEach((btn) => {
    const key = btn.dataset.hold as HoldKey;
    const pointers = new Set<number>();
    const sync = (): void => {
      virtualInput[key] = pointers.size > 0;
      btn.classList.toggle("pressed", pointers.size > 0);
    };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      virtualInput.anyTouch = true;
      capture(btn, e.pointerId);
      pointers.add(e.pointerId);
      sync();
    });
    const release = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      sync();
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
  });

  // --- 押した瞬間に1回だけのボタン（CAM / PAUSE。SND は main.ts の #mute-btn） ---
  type TapKey = "cameraToggle" | "pauseToggle";
  const TAP_KEYS: Record<string, TapKey> = {
    camera: "cameraToggle",
    pause: "pauseToggle",
  };
  root.querySelectorAll<HTMLElement>("[data-tap]").forEach((btn) => {
    const key = TAP_KEYS[btn.dataset.tap ?? ""];
    if (!key) return;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      virtualInput.anyTouch = true;
      virtualInput[key] = true;
      // 押した感触のフィードバック（すぐ消す）
      btn.classList.add("pressed");
      window.setTimeout(() => btn.classList.remove("pressed"), 150);
    });
  });
}
